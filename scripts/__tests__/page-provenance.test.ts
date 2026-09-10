/**
 * PAGE PROVENANCE (F189) — the staleness signal must not cry wolf.
 *
 * A staleness check earns its place by being SILENT when nothing meaningful changed. One that
 * fires on re-serialisation or on a timestamp is ignored within a week and then it is worse than
 * absent, because everyone believes something is watching. So most of these assert that it does
 * NOT fire.
 */
import { describe, it, expect } from 'vitest';
import { hashFacts, isSubstantive, findStale, type ProvQuad, type PageProvenance } from '../lib/page-provenance';

const KPRED = 'urn:kbase:predicate/';
const E = 'urn:kbase:concept/graph-publishing';
const q = (p: string, o: string, subject = E): ProvQuad => ({
  subject: { value: subject },
  predicate: { value: p.startsWith('urn:') ? p : KPRED + p },
  object: { value: o, termType: 'Literal' },
});

describe('what counts as a substantive fact', () => {
  it('treats a status change as substantive — the case Matt named', () => {
    // kpred:has-status classifies as JUDGMENT (rank 3), well clear of the floor. "A feature is now
    // in production" must reach any page that mentions it.
    expect(isSubstantive(q('has-status', 'production'))).toBe(true);
  });

  it('treats a decision and a measurement as substantive', () => {
    expect(isSubstantive(q('decided', 'we chose the graph'))).toBe(true);
    expect(isSubstantive(q('measured', '51 rival names'))).toBe(true);
  });

  it('does NOT treat a log-level fact as substantive — the requirement, literally', () => {
    expect(isSubstantive(q('completed-on', '2026-09-08'))).toBe(false);
  });
});

describe('the hash moves only when meaning moves', () => {
  const base = [q('has-status', 'planned'), q('description', 'A thing.')];

  it('changes when a status changes', () => {
    const before = hashFacts(base, E);
    const after = hashFacts([q('has-status', 'production'), q('description', 'A thing.')], E);
    expect(after.factHash).not.toBe(before.factHash);
  });

  it('does NOT change when a log-level fact is added', () => {
    // The whole requirement in one assertion.
    const after = hashFacts([...base, q('completed-on', '2026-09-08')], E);
    expect(after.factHash).toBe(hashFacts(base, E).factHash);
  });

  it('does NOT change when the same facts are re-ordered', () => {
    // n3 emits in file order, so a re-serialisation that moves a line must not read as drift.
    expect(hashFacts([...base].reverse(), E).factHash).toBe(hashFacts(base, E).factHash);
  });

  it('ignores facts about OTHER entities in the same graph file', () => {
    const withNoise = [...base, q('has-status', 'production', 'urn:kbase:concept/something-else')];
    expect(hashFacts(withNoise, E).factHash).toBe(hashFacts(base, E).factHash);
  });

  it('counts the facts it hashed, so a silent drop to zero is visible', () => {
    expect(hashFacts(base, E).factCount).toBeGreaterThan(0);
    expect(hashFacts([], E).factCount).toBe(0);
  });
});

describe('finding the pages a change should have moved', () => {
  const graph = 'docs-architecture.ttl';
  const facts = [q('has-status', 'planned'), q('description', 'A thing.')];
  const recorded = (): PageProvenance[] => [{
    path: 'architecture/graph-publishing', entity: E, graph,
    ...hashFacts(facts, E), floor: 'evidence',
  }];

  it('reports nothing when the graph is unchanged', () => {
    expect(findStale(recorded(), new Map([[graph, facts]]))).toEqual([]);
  });

  it('reports nothing when only a log-level fact was added', () => {
    const noisier = [...facts, q('completed-on', '2026-09-08')];
    expect(findStale(recorded(), new Map([[graph, noisier]]))).toEqual([]);
  });

  it('reports the page when a status moved to production', () => {
    const changed = [q('has-status', 'production'), q('description', 'A thing.')];
    const stale = findStale(recorded(), new Map([[graph, changed]]));
    expect(stale).toHaveLength(1);
    expect(stale[0].path).toBe('architecture/graph-publishing');
    expect(stale[0].reason).toBe('changed');
  });

  it('distinguishes a DELETED entity from an edited one', () => {
    // An entity removed from under a published page is a stronger signal than one edited, and
    // collapsing the two would let a deletion look like routine drift.
    const stale = findStale(recorded(), new Map([[graph, []]]));
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toBe('entity-gone');
  });

  it('reports a page whose whole graph file has vanished', () => {
    expect(findStale(recorded(), new Map()).map((s) => s.reason)).toEqual(['entity-gone']);
  });
});
