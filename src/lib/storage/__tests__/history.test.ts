/**
 * History Mode reconstruction (kb:history-mode).
 *
 * This feature was marked `production` and had NO tests. The first ones written for it
 * found two defects, both of which made the graph LIE about the past:
 *
 *   1. A fact you had deleted was invisible at EVERY past timestamp — the reconstruction
 *      filtered the current statement set, and a deleted statement is not in it.
 *   2. Trust scores in History Mode used a stale COPY of the trust maths, without the
 *      baseline — the exact bug fixed in trust.ts, still live here because the logic was
 *      duplicated instead of imported.
 *
 * See history.ts.
 */
import { describe, it, expect } from 'vitest';
import { reconstructStatementsAt, reconstructSourcesAt } from '../history';
import { BASELINE_REVIEW, BASELINE_TRUSTED, computeTrustScore } from '../trust';
import type { Statement, Source } from '$lib/rdf/types';
import type { ChangeLogEntry } from '../types';

const T = (n: number) => 1_800_000_000_000 + n * 1000;
const iri = (v: string) => ({ kind: 'iri' as const, value: v });

function stmt(id: string, o = 'o', sourceId = 'src-1'): Statement {
  return {
    id,
    s: iri(`urn:kbase:concept/${id}-s`),
    p: iri('urn:kbase:predicate/knows'),
    o: iri(`urn:kbase:concept/${o}`),
    g: iri(`urn:kbase:source/${sourceId}`),
    sourceId,
    confidence: 1,
    status: 'confirmed',
    createdAt: T(0),
    updatedAt: T(0),
  };
}

function log(
  action: ChangeLogEntry['action'],
  statementId: string,
  timestamp: number,
  extra: Partial<ChangeLogEntry> = {},
): ChangeLogEntry {
  return { action, statementId, timestamp, ...extra };
}

/** A delete entry as the app actually writes it (kb.svelte.ts deleteStatement). */
function tombstone(st: Statement, timestamp: number): ChangeLogEntry {
  return log('delete', st.id, timestamp, {
    sourceId: st.sourceId,
    before: JSON.stringify({ s: st.s, p: st.p, o: st.o }),
  });
}

describe('reconstructStatementsAt', () => {
  it('returns the live graph unfiltered when the timestamp is null (present)', () => {
    const current = [stmt('a'), stmt('b')];
    const result = reconstructStatementsAt(current, [], null);
    expect(result.statements).toEqual(current);
    expect(result.undated).toEqual([]);
  });

  it('hides a fact that had not been added yet', () => {
    const a = stmt('a');
    const changelog = [log('add', 'a', T(100))];

    expect(reconstructStatementsAt([a], changelog, T(50)).statements).toEqual([]);
    expect(reconstructStatementsAt([a], changelog, T(150)).statements).toEqual([a]);
  });

  it('includes a fact added exactly at the requested instant', () => {
    const a = stmt('a');
    const result = reconstructStatementsAt([a], [log('add', 'a', T(100))], T(100));
    expect(result.statements).toEqual([a]);
  });

  it('treats an ingested fact the same as an added one', () => {
    const a = stmt('a');
    const result = reconstructStatementsAt([a], [log('ingest', 'a', T(100))], T(150));
    expect(result.statements).toEqual([a]);
  });

  // ── BUG 1 ──────────────────────────────────────────────────────────────────
  //
  // Deletion is a HARD delete, so a fact deleted since T is not in the current set.
  // The old code built the past by FILTERING that set, so it could never put the fact
  // back: scrubbing to a time when the fact plainly existed showed a graph without it.
  // History Mode could only hide recent additions — the one thing it could not do was
  // show you what you had lost, which is what you open a history for.
  // ───────────────────────────────────────────────────────────────────────────
  describe('a fact that has since been deleted', () => {
    const a = stmt('a', 'the-deleted-object');
    const changelog = [log('add', 'a', T(100)), tombstone(a, T(200))];
    const currentAfterDelete: Statement[] = []; // hard-deleted: gone from the live set

    it('REAPPEARS at a time when it existed', () => {
      const result = reconstructStatementsAt(currentAfterDelete, changelog, T(150));
      expect(result.statements).toHaveLength(1);
      expect(result.statements[0].id).toBe('a');
    });

    it('is resurrected with its real subject, predicate and object', () => {
      const [revived] = reconstructStatementsAt(currentAfterDelete, changelog, T(150)).statements;
      expect(revived.s).toEqual(a.s);
      expect(revived.p).toEqual(a.p);
      expect(revived.o).toEqual(a.o);
      expect(revived.sourceId).toBe('src-1');
    });

    it('carries the arrival time recorded in the changelog, not an invented one', () => {
      const [revived] = reconstructStatementsAt(currentAfterDelete, changelog, T(150)).statements;
      expect(revived.createdAt).toBe(T(100)); // when it was actually added
      expect(revived.updatedAt).toBe(T(200)); // when it was deleted
    });

    it('stays gone after the moment it was deleted', () => {
      expect(reconstructStatementsAt(currentAfterDelete, changelog, T(250)).statements).toEqual([]);
      // and at the exact instant of deletion
      expect(reconstructStatementsAt(currentAfterDelete, changelog, T(200)).statements).toEqual([]);
    });

    it('is still absent before it was ever added', () => {
      expect(reconstructStatementsAt(currentAfterDelete, changelog, T(50)).statements).toEqual([]);
    });
  });

  it('drops a fact whose tombstone is unreadable rather than rendering half of it', () => {
    // A corrupt `before` payload cannot be honestly reconstructed. Better an admitted
    // absence than a statement with a missing object presented as a fact.
    const changelog = [
      log('add', 'a', T(100)),
      log('delete', 'a', T(200), { before: '{not json' }),
      log('add', 'b', T(100)),
      log('delete', 'b', T(200)), // no `before` at all
    ];
    expect(reconstructStatementsAt([], changelog, T(150)).statements).toEqual([]);
  });

  // Replaying in TIME order matters: the old code took `.first()` matching entry, which is
  // Dexie index order, not chronological — so a re-added fact resolved by luck.
  it('handles add → delete → re-add across the whole timeline', () => {
    const a = stmt('a');
    const changelog = [
      log('add', 'a', T(100)),
      tombstone(a, T(200)),
      log('add', 'a', T(300)),
    ];
    const at = (t: number) => reconstructStatementsAt([a], changelog, t).statements.length;

    expect(at(T(50))).toBe(0); // before it ever existed
    expect(at(T(150))).toBe(1); // first life
    expect(at(T(250))).toBe(0); // deleted
    expect(at(T(350))).toBe(1); // re-added
  });

  it('is not fooled by changelog entries arriving out of order', () => {
    const a = stmt('a');
    const shuffled = [tombstone(a, T(200)), log('add', 'a', T(300)), log('add', 'a', T(100))];
    const at = (t: number) => reconstructStatementsAt([a], shuffled, t).statements.length;

    expect(at(T(150))).toBe(1);
    expect(at(T(250))).toBe(0);
    expect(at(T(350))).toBe(1);
  });

  it('ignores actions that are neither an arrival nor a departure', () => {
    const a = stmt('a');
    const changelog = [
      log('add', 'a', T(100)),
      log('confirm', 'a', T(120)),
      log('supersede', 'a', T(140)),
    ];
    expect(reconstructStatementsAt([a], changelog, T(150)).statements).toEqual([a]);
  });

  it('ignores changelog entries that reference no statement (merges, trust updates)', () => {
    const a = stmt('a');
    const changelog = [
      log('add', 'a', T(100)),
      { action: 'trust_update', timestamp: T(120), sourceId: 'src-1' } as ChangeLogEntry,
      { action: 'merge', timestamp: T(130), entityKey: 'k' } as ChangeLogEntry,
    ];
    expect(reconstructStatementsAt([a], changelog, T(150)).statements).toEqual([a]);
  });

  // ── THE DECLARED GAP ───────────────────────────────────────────────────────
  //
  // A statement with no arrival record cannot be dated. The old code silently EXCLUDED
  // it — so a graph seeded from TTL (no changelog) showed an empty history at every past
  // time, with no explanation. We refuse to guess in either direction and report the
  // count instead: an admitted gap, not a silent one.
  // ───────────────────────────────────────────────────────────────────────────
  describe('facts with no recorded arrival', () => {
    it('reports them separately instead of silently dropping or including them', () => {
      const dated = stmt('dated');
      const seeded = stmt('seeded'); // e.g. imported from TTL before the changelog existed
      const result = reconstructStatementsAt(
        [dated, seeded],
        [log('add', 'dated', T(100))],
        T(150),
      );

      expect(result.statements).toEqual([dated]);
      expect(result.undated).toEqual([seeded]); // surfaced to the user, not assumed away
    });

    it('does not count a deleted-and-undated fact as present', () => {
      const result = reconstructStatementsAt([], [], T(150));
      expect(result.statements).toEqual([]);
      expect(result.undated).toEqual([]);
    });
  });
});

describe('reconstructSourcesAt', () => {
  const source = (id: string, trustLevel?: 'trusted' | 'review'): Source => ({
    id,
    title: id,
    uri: `note://${id}`,
    ingestedAt: T(0),
    kind: 'note',
    trustLevel,
  });

  it('returns sources untouched in the present', () => {
    const sources = [source('src-1', 'trusted')];
    expect(reconstructSourcesAt(sources, [], null)).toEqual(sources);
  });

  // ── BUG 2 ──────────────────────────────────────────────────────────────────
  //
  // The page had its own copy of the trust maths — the PRE-FIX copy, which summed the
  // deltas and threw the baseline away. So in History Mode a trusted source that the
  // user had confirmed once scored 0.05 instead of 0.85: the same "confirming a fact
  // makes its source less trusted" bug, surviving in a second place because the logic
  // was duplicated rather than imported. It now calls computeTrustScore — one
  // implementation of trust in the codebase, not two.
  // ───────────────────────────────────────────────────────────────────────────
  it('keeps the baseline when a source has been judged (does not collapse to Σ deltas)', () => {
    const sources = [source('src-1', 'trusted')];
    const events = [{ sourceId: 'src-1', delta: 0.05, timestamp: T(100) }];

    const [rebuilt] = reconstructSourcesAt(sources, events, T(150));

    expect(rebuilt.trustScore).toBeGreaterThan(BASELINE_TRUSTED); // confirming HELPS
    expect(rebuilt.trustScore).not.toBeCloseTo(0.05, 2); // the old, broken answer
  });

  it('scores exactly as the live app does, at the historical instant', () => {
    const sources = [source('src-1', 'review')];
    const events = [
      { sourceId: 'src-1', delta: 0.05, timestamp: T(100) },
      { sourceId: 'src-1', delta: -0.1, timestamp: T(120) },
    ];

    const [rebuilt] = reconstructSourcesAt(sources, events, T(150));

    expect(rebuilt.trustScore).toBeCloseTo(
      computeTrustScore(
        events.map((e) => ({ delta: e.delta, timestamp: e.timestamp })),
        'review',
        T(150),
      ),
      10,
    );
  });

  it('gives an unjudged source its baseline, not zero', () => {
    const [reviewed] = reconstructSourcesAt([source('a', 'review')], [], T(150));
    const [trusted] = reconstructSourcesAt([source('b', 'trusted')], [], T(150));

    expect(reviewed.trustScore).toBe(BASELINE_REVIEW);
    expect(trusted.trustScore).toBe(BASELINE_TRUSTED);
  });

  it('ignores judgements the user had not made yet', () => {
    const sources = [source('src-1', 'review')];
    const events = [{ sourceId: 'src-1', delta: -0.1, timestamp: T(500) }]; // a future rejection

    const [rebuilt] = reconstructSourcesAt(sources, events, T(150));

    // At T(150) the user had not rejected anything, so the source stands at its baseline.
    expect(rebuilt.trustScore).toBe(BASELINE_REVIEW);
  });

  it('does not leak one source’s judgements into another', () => {
    const sources = [source('src-1', 'review'), source('src-2', 'review')];
    const events = [{ sourceId: 'src-1', delta: -0.1, timestamp: T(100) }];

    const [a, b] = reconstructSourcesAt(sources, events, T(150));

    expect(a.trustScore).toBeLessThan(BASELINE_REVIEW);
    expect(b.trustScore).toBe(BASELINE_REVIEW);
  });
});
