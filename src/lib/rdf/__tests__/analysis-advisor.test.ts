/**
 * Analysis advisor — the guard rails matter more than the happy path.
 *
 * The failure that actually hurts the user is recommending a PAID analysis to someone who is
 * already drowning in unreviewed facts: it spends tokens to deepen the queue they cannot get
 * through. So these tests pin the ordering rule (free-and-unblocking outranks paid-and-adding),
 * the overfill case Matt described, and the floor below which no analysis is worth running.
 */
import { describe, it, expect } from 'vitest';
import { computeSignals, recommendActions, adviseGraph } from '../analysis-advisor';
import type { Statement, Term, NamedNode } from '../types';

const iri = (value: string): NamedNode => ({ kind: 'iri', value });
const lit = (value: string): Term => ({ kind: 'literal', value });
let n = 0;
const st = (
  s: string, p: string, o: Term,
  status: Statement['status'] = 'confirmed',
  sourceId = 'src-1',
): Statement => ({
  id: `s${n++}`, s: iri(s), p: iri(p), o, g: iri('urn:g'), sourceId,
  confidence: 1, status, createdAt: 0, updatedAt: 0,
});
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const label = (s: string, l: string, status?: Statement['status']) => st(s, RDFS_LABEL, lit(l), status);
const edge = (s: string, o: string, status?: Statement['status'], src?: string) =>
  st(s, 'urn:kbase:predicate/relates-to', iri(o), status, src);
const typed = (s: string) => st(s, RDF_TYPE, iri('urn:kbase:type/Concept'));

/** A healthy graph: well-connected, typed, distinct labels, nothing pending. */
function healthyGraph(size = 20): Statement[] {
  const out: Statement[] = [];
  for (let i = 0; i < size; i++) {
    out.push(label(`urn:e${i}`, `Entity ${i}`), typed(`urn:e${i}`));
    out.push(edge(`urn:e${i}`, `urn:e${(i + 1) % size}`));
    out.push(edge(`urn:e${i}`, `urn:e${(i + 2) % size}`));
    out.push(edge(`urn:e${i}`, `urn:e${(i + 3) % size}`));
  }
  return out;
}

describe('computeSignals', () => {
  it('counts nothing on an empty graph without dividing by zero', () => {
    const s = computeSignals([]);
    expect(s.totalStatements).toBe(0);
    expect(s.pendingRatio).toBe(0);
    expect(s.duplicateLabelRate).toBe(0);
    expect(s.islandRate).toBe(0);
  });

  it('ignores rejected and superseded statements', () => {
    const stmts = [
      label('urn:a', 'A'), edge('urn:a', 'urn:b'),
      edge('urn:a', 'urn:c', 'rejected'),
      edge('urn:a', 'urn:d', 'superseded'),
    ];
    // Only the active edge counts toward the graph.
    expect(computeSignals(stmts).totalStatements).toBe(2);
  });

  it('measures pending pressure as both a count and a ratio', () => {
    const stmts = [
      ...healthyGraph(5),
      ...Array.from({ length: 30 }, (_, i) => edge('urn:new', `urn:t${i}`, 'pending', 'src-flood')),
    ];
    const s = computeSignals(stmts);
    expect(s.pendingCount).toBe(30);
    expect(s.pendingRatio).toBeGreaterThan(0.5);
    expect(s.unreviewedSources).toBe(1);
  });

  it('detects duplicate labels case- and whitespace-insensitively', () => {
    const stmts = [
      label('urn:a', 'Acme Corp'), edge('urn:a', 'urn:x'),
      label('urn:b', 'acme  corp'), edge('urn:b', 'urn:x'),
      label('urn:c', 'Distinct Thing'), edge('urn:c', 'urn:x'),
    ];
    // 2 of 3 labelled entities collide (urn:x has no label of its own and is not a subject).
    expect(computeSignals(stmts).duplicateLabelRate).toBeCloseTo(2 / 3, 5);
  });

  it('counts blocking questions separately from plain open ones', () => {
    const open: Statement = { ...edge('urn:a', 'urn:?'), needsObject: true };
    const blocking: Statement = { ...edge('urn:b', 'urn:?'), needsObject: true, blocks: ['urn:x', 'urn:y'] };
    const s = computeSignals([open, blocking]);
    expect(s.openQuestions).toBe(2);
    expect(s.blockingQuestions).toBe(1);
  });
});

describe('recommendActions — the overfill case', () => {
  // Matt's scenario: enthusiastic source additions, review left behind.
  const overfilled = [
    ...healthyGraph(6),
    ...Array.from({ length: 200 }, (_, i) =>
      edge(`urn:flood${i}`, 'urn:hub', 'pending', `src-${i % 5}`)),
  ];

  it('tells the user to review, and says how deep the queue is', () => {
    const recs = adviseGraph(overfilled);
    expect(recs[0].action).toBe('review');
    expect(recs[0].reason).toMatch(/200 facts from 5 source/);
    expect(recs[0].free).toBe(true);
  });

  it('offers the free queue-prune alongside review', () => {
    const recs = adviseGraph(overfilled);
    expect(recs.map((r) => r.action)).toContain('prune-suggestions');
  });

  it('NEVER ranks a paid analysis above review while the queue is hot', () => {
    const recs = adviseGraph(overfilled);
    const firstPaid = recs.findIndex((r) => !r.free);
    const reviewAt = recs.findIndex((r) => r.action === 'review');
    // Either no paid analysis at all, or it sits strictly below review.
    expect(firstPaid === -1 || firstPaid > reviewAt).toBe(true);
  });
});

describe('recommendActions — floors and restraint', () => {
  it('recommends nothing for a healthy graph', () => {
    expect(adviseGraph(healthyGraph(20))).toEqual([]);
  });

  it('does not recommend paid analysis on a graph too small to reason over', () => {
    // Three entities, all untyped and all islands — every ratio is maxed, but there is
    // nothing here worth spending tokens on.
    const tiny = [label('urn:a', 'A'), label('urn:b', 'B'), label('urn:c', 'C')];
    expect(adviseGraph(tiny).filter((r) => !r.free)).toEqual([]);
  });

  it('suggests merge when labels collide often enough', () => {
    const stmts = healthyGraph(20);
    // Rename a quarter of them to the same label.
    for (let i = 0; i < 5; i++) stmts.push(label(`urn:dup${i}`, 'Same Name'), edge(`urn:dup${i}`, 'urn:e0'));
    const recs = adviseGraph(stmts);
    expect(recs.map((r) => r.action)).toContain('merge');
    expect(recs.find((r) => r.action === 'merge')!.free).toBe(false);
  });

  it('suggests entity-types when most entities are untyped', () => {
    const stmts: Statement[] = [];
    for (let i = 0; i < 20; i++) {
      stmts.push(label(`urn:u${i}`, `U${i}`));
      stmts.push(edge(`urn:u${i}`, `urn:u${(i + 1) % 20}`), edge(`urn:u${i}`, `urn:u${(i + 2) % 20}`), edge(`urn:u${i}`, `urn:u${(i + 3) % 20}`));
    }
    expect(adviseGraph(stmts).map((r) => r.action)).toContain('entity-types');
  });

  it('offers the free prune BEFORE the paid enrich when entities are sparse', () => {
    const sparse: Statement[] = [];
    for (let i = 0; i < 20; i++) sparse.push(label(`urn:i${i}`, `Island ${i}`), typed(`urn:i${i}`), edge(`urn:i${i}`, 'urn:hub'));
    const recs = adviseGraph(sparse);
    const pruneAt = recs.findIndex((r) => r.action === 'prune-nodes');
    const enrichAt = recs.findIndex((r) => r.action === 'enrich');
    expect(pruneAt).toBeGreaterThanOrEqual(0);
    expect(enrichAt).toBeGreaterThan(pruneAt);
  });

  it('prioritizes blocking questions — they cost the most to leave unanswered', () => {
    const stmts: Statement[] = [
      ...healthyGraph(20),
      { ...edge('urn:q', 'urn:?'), needsObject: true, blocks: ['urn:e1', 'urn:e2', 'urn:e3'] },
    ];
    const recs = adviseGraph(stmts);
    expect(recs[0].action).toBe('answer-questions');
    expect(recs[0].reason).toMatch(/blocking/);
  });

  it('surfaces churn from the archive journal as a free diagnostic (F97.6)', () => {
    const recs = recommendActions(computeSignals(healthyGraph(20)), {
      churningEntities: ['urn:noisy1', 'urn:noisy2'],
    });
    const churn = recs.find((r) => r.action === 'inspect-churn')!;
    expect(churn).toBeDefined();
    expect(churn.free).toBe(true);
    // Framed as a pipeline problem, not a user failing.
    expect(churn.reason).toMatch(/noisy source or extraction prompt/);
  });

  it('says nothing about churn when the archive reports none', () => {
    const recs = recommendActions(computeSignals(healthyGraph(20)), { churningEntities: [] });
    expect(recs.map((r) => r.action)).not.toContain('inspect-churn');
  });

  it('respects caller-tuned thresholds', () => {
    const stmts = healthyGraph(20);
    // Nothing pending, so no review — but a zero floor makes islands trip.
    const recs = recommendActions(computeSignals(stmts), { islandFloor: -1 });
    expect(recs.map((r) => r.action)).toContain('prune-nodes');
  });
});
