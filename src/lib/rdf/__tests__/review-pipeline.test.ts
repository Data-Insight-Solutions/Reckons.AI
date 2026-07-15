/**
 * The review pipeline — end-to-end composition of F80.1 dedupe -> F88 routing -> F53 spotlight ->
 * F83 entity cards. This is the integration guard: the unit tests prove each stage; this proves
 * they compose (types line up, order is right, nothing double-counts).
 */
import { describe, it, expect } from 'vitest';
import { buildReviewPlan, reviewPlanSummary } from '../review-pipeline';
import type { Statement, ReviewStatus } from '../types';

let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: extra.confidence ?? 0.7,
    status: (extra.status ?? 'pending') as ReviewStatus,
    createdAt: extra.createdAt ?? n,
    updatedAt: n,
    ...extra,
  } as Statement;
}

const NOTE = 'urn:kbase:predicate/note';       // user-gated (judgement)
const HASFILE = 'urn:kbase:predicate/has-file'; // machine-gated (path)
const A = 'urn:kbase:concept/alpha';
const B = 'urn:kbase:concept/beta';

describe('buildReviewPlan — the four stages compose', () => {
  it('folds duplicates, routes by competence, and cards the user lane', () => {
    const pending: Statement[] = [
      st(A, NOTE, 'a judgement', { id: 'u1' }),
      st(A, NOTE, 'a judgement', { id: 'u2' }), // exact duplicate of u1 -> folded
      st(A, NOTE, 'another call', { id: 'u3' }),
      st(B, HASFILE, 'src/lib/x.ts', { id: 'm1' }), // machine lane
    ];
    const plan = buildReviewPlan(pending);

    // 1. dedupe folded the exact duplicate
    expect(plan.folded).toBe(1);
    expect(plan.deduped).toHaveLength(3);

    // 2. routing: the path fact is machine's, the notes are the user's
    expect(plan.routed.machine.map((i) => i.statement.id)).toContain('m1');
    const userIds = plan.routed.user.map((i) => i.statement.id).sort();
    expect(userIds).toEqual(['u1', 'u3']); // u2 folded, m1 is machine

    // 3. entity cards: the two user notes are ONE alpha card, not two rows
    expect(plan.entityCards).toHaveLength(1);
    expect(plan.entityCards[0].entityIri).toBe(A);
    expect(plan.entityCards[0].facts).toHaveLength(2);
  });

  it('a partial fact (decision) reaches the spotlight; machine facts never enter the user lane', () => {
    const pending: Statement[] = [
      st(A, 'urn:kbase:predicate/owner', '?', { id: 'q', needsObject: true }),
      st(B, HASFILE, 'src/lib/y.ts', { id: 'm' }),
    ];
    const plan = buildReviewPlan(pending);
    expect(plan.routed.user.map((i) => i.statement.id)).toEqual(['q']);
    expect(plan.attention.spotlight.map((i) => i.statement.id)).toContain('q');
    expect(plan.routed.machine.map((i) => i.statement.id)).toContain('m');
  });

  it('partial-fact duplicates are NOT folded (blocks/question could differ)', () => {
    const pending: Statement[] = [
      st(A, 'urn:kbase:predicate/owner', '?', { id: 'q1', needsObject: true }),
      st(A, 'urn:kbase:predicate/owner', '?', { id: 'q2', needsObject: true }),
    ];
    const plan = buildReviewPlan(pending);
    expect(plan.folded).toBe(0);
    expect(plan.deduped).toHaveLength(2);
  });

  it('summary is honest about what was spared and what is left', () => {
    const pending: Statement[] = [
      st(A, NOTE, 'x', { id: 'u1' }),
      st(B, HASFILE, 'src/z.ts', { id: 'm1' }),
    ];
    const s = reviewPlanSummary(buildReviewPlan(pending));
    expect(s).toMatch(/settled without you/);
    expect(s).toMatch(/1 entity yours/);
  });

  it('an all-machine queue leaves nothing for the human', () => {
    const plan = buildReviewPlan([st(A, HASFILE, 'src/a.ts', { id: 'm1' })]);
    expect(plan.routed.user).toHaveLength(0);
    expect(reviewPlanSummary(plan)).toMatch(/nothing left for you/i);
  });

  it('empty in, empty out', () => {
    const plan = buildReviewPlan([]);
    expect(plan.deduped).toHaveLength(0);
    expect(plan.entityCards).toHaveLength(0);
    expect(plan.folded).toBe(0);
  });
});
