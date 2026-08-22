/**
 * Retention by altitude — age out events without aging out decisions.
 *
 * The rule under test is REFERENCE BEATS AGE. Without it, "archive events older than N days"
 * quietly hollows out the reasoning: the ruling survives and the thing it cites does not.
 */
import { describe, it, expect } from 'vitest';
import {
  retentionClassOf, partitionForArchive, referencedSubjects, retentionSummary,
  RETENTION_BY_ALTITUDE,
} from '../retention';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
const DEPLOY = 'urn:kbase:concept/deploy';
const MAST = 'urn:kbase:concept/mast';

let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p },
    o: extra.o ?? { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' }, sourceId: 'x', confidence: 1, status: 'confirmed',
    createdAt: extra.createdAt ?? n, updatedAt: n,
    ...extra,
  } as Statement;
}
const iri = (v: string) => ({ kind: 'iri' as const, value: v });
const OLD = 1_000, NEW = 9_000, CUTOFF = 5_000;

describe('retention class follows altitude', () => {
  it('only events are ageable; decisions, judgments and evidence never are', () => {
    expect(RETENTION_BY_ALTITUDE.log).toBe('ageable');
    expect(RETENTION_BY_ALTITUDE.record).toBe('conditional');
    expect(RETENTION_BY_ALTITUDE.evidence).toBe('keep');
    expect(RETENTION_BY_ALTITUDE.judgment).toBe('keep');
    expect(RETENTION_BY_ALTITUDE.decision).toBe('keep');
  });

  it('classifies a real decision fact as keep', () => {
    expect(retentionClassOf(st(MAST, `${KPRED}decided`, 'We chose the county mast.'))).toBe('keep');
  });
});

describe('partitionForArchive', () => {
  it('archives an old event and keeps an old decision', () => {
    const all = [
      st(DEPLOY, `${KPRED}last-reviewed`, '2026-01-02', { createdAt: OLD, id: 'ev' }),
      st(MAST, `${KPRED}decided`, 'We chose the county mast.', { createdAt: OLD, id: 'dec' }),
    ];
    const p = partitionForArchive(all, { olderThan: CUTOFF });
    expect(p.archive.map((s) => s.id)).toEqual(['ev']);
    expect(p.keep.map((s) => s.id)).toEqual(['dec']);
  });

  it('never archives a recent event, however ageable its kind', () => {
    const all = [st(DEPLOY, `${KPRED}last-reviewed`, '2026-08-20', { createdAt: NEW, id: 'ev' })];
    expect(partitionForArchive(all, { olderThan: CUTOFF }).archive).toEqual([]);
  });

  it('HOLDS BACK an old event a decision still refers to, and says why', () => {
    // The load-bearing rule. Archiving this would leave the ruling asserting something with
    // nothing behind it.
    const all = [
      st(DEPLOY, `${KPRED}last-reviewed`, '2026-01-02', { createdAt: OLD, id: 'ev' }),
      st(MAST, `${KPRED}decided`, 'Chosen because of the deploy.', { createdAt: OLD, id: 'dec', o: iri(DEPLOY) }),
    ];
    const p = partitionForArchive(all, { olderThan: CUTOFF });
    expect(p.archive).toEqual([]);
    expect(p.heldBack).toHaveLength(1);
    expect(p.heldBack[0].statement.id).toBe('ev');
    expect(p.heldBack[0].reason).toMatch(/still refers to/);
  });

  it('lets the reference guard be turned off deliberately, and it is still reported', () => {
    const all = [
      st(DEPLOY, `${KPRED}last-reviewed`, '2026-01-02', { createdAt: OLD, id: 'ev' }),
      st(MAST, `${KPRED}decided`, 'Chosen because of the deploy.', { createdAt: OLD, id: 'dec', o: iri(DEPLOY) }),
    ];
    const p = partitionForArchive(all, { olderThan: CUTOFF, ignoreReferences: true });
    expect(p.archive.map((s) => s.id)).toEqual(['ev']);
  });

  it('leaves bookkeeping alone unless records are opted in', () => {
    const rec = st(MAST, `${KPRED}has-file`, 'docs/mast.md', { createdAt: OLD, id: 'rec' });
    expect(partitionForArchive([rec], { olderThan: CUTOFF }).archive).toEqual([]);
    expect(partitionForArchive([rec], { olderThan: CUTOFF, includeRecords: true }).archive.map((s) => s.id))
      .toEqual(['rec']);
  });
});

describe('referencedSubjects', () => {
  it('counts both what a decision points at and what it is about', () => {
    const all = [st(MAST, `${KPRED}decided`, 'because of the deploy', { o: iri(DEPLOY) })];
    const refs = referencedSubjects(all);
    expect(refs.has(DEPLOY)).toBe(true);
    expect(refs.has(MAST)).toBe(true);
  });

  it('a log-altitude event referring to something does not protect it', () => {
    // Otherwise every timestamp would immunise whatever it mentions, and nothing would age out.
    // kpred:progress is in LOG_PREDICATES, so this is genuinely a log fact.
    const all = [st(DEPLOY, `${KPRED}progress`, 'touched the mast config', { o: iri(MAST) })];
    expect(referencedSubjects(all).has(MAST)).toBe(false);
  });

  it('an UNCLASSIFIED predicate protects, because unknown defaults to judgment', () => {
    /*
     * This is the fail-safe direction and it is deliberate. altitudeOf() sends any predicate it
     * does not recognise to `judgment`, and the roadmap census counts 186 such predicates. Under
     * retention that means an unrecognised relation PROTECTS what it points at rather than
     * exposing it — the cost is that some things are kept longer than necessary, and the
     * alternative cost is archiving evidence out from under a live ruling because nobody had
     * classified the predicate yet.
     */
    const all = [st(DEPLOY, `${KPRED}some-unclassified-relation`, '', { o: iri(MAST) })];
    expect(referencedSubjects(all).has(MAST)).toBe(true);
  });
});

describe('retentionSummary — say what it would not do, too', () => {
  it('reports archivable, held back, and kept separately', () => {
    const all = [
      st(DEPLOY, `${KPRED}last-reviewed`, '2026-01-02', { createdAt: OLD, id: 'ev' }),
      st('urn:kbase:concept/other', `${KPRED}last-reviewed`, '2026-01-03', { createdAt: OLD, id: 'ev2' }),
      st(MAST, `${KPRED}decided`, 'Chosen because of the deploy.', { createdAt: OLD, id: 'dec', o: iri(DEPLOY) }),
    ];
    const s = retentionSummary(partitionForArchive(all, { olderThan: CUTOFF }));
    expect(s).toMatch(/1 event archivable/);
    expect(s).toMatch(/1 held back because a decision still refers/);
    expect(s).toMatch(/do not age out/);
  });

  it('is plain when there is nothing to do', () => {
    const p = partitionForArchive([st(MAST, `${KPRED}decided`, 'x', { createdAt: OLD })], { olderThan: CUTOFF });
    expect(retentionSummary(p)).toMatch(/Nothing to archive/);
  });
});
