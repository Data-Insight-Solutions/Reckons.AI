/**
 * F139 review tree — decisions at the top, the case for them underneath, bookkeeping behind a
 * number. The three rules under test: an option's cost is COMPUTED, a settled decision is
 * CONTEXT, and two human opinions in conflict go to STP rather than accept/reject.
 */
import { describe, it, expect } from 'vitest';
import {
  buildReviewTree, optionCost, optionsFor, needsStp, distillationRequest, reviewTreeSummary,
  questionText,
} from '../review-tree';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: extra.o ?? { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: 'pending',
    createdAt: n,
    updatedAt: n,
    ...extra,
  } as Statement;
}
const iri = (v: string) => ({ kind: 'iri' as const, value: v });

const WEEKEND = 'urn:kbase:concept/the-weekend';
const LAKE = 'urn:kbase:concept/lake-george';
const RIDGE = 'urn:kbase:concept/oh-ridge';

describe('optionCost — an option is priced in the facts it kills', () => {
  const campfire = st('urn:kbase:concept/ev-campfire', `${KPRED}ruled-out-by`, '', { o: iri(LAKE) });
  const sunrise = st('urn:kbase:concept/ev-sunrise', `${KPRED}ruled-out-by`, '', { o: iri(RIDGE) });

  it('computes the cost from the graph, never from prose', () => {
    const cost = optionCost(LAKE, [campfire, sunrise]);
    expect(cost).toHaveLength(1);
    expect(cost[0].s.value).toContain('campfire');
  });

  it('derives both options and prices each independently', () => {
    const all = [
      st(WEEKEND, `${KPRED}open-question`, 'Lake George or Oh! Ridge?'),
      st('urn:kbase:concept/ev-campfire', `${KPRED}part-of`, '', { o: iri(WEEKEND) }),
      campfire,
      st('urn:kbase:concept/ev-sunrise', `${KPRED}part-of`, '', { o: iri(WEEKEND) }),
      sunrise,
      st(LAKE, RDFS_LABEL, 'Lake George'),
      st(RIDGE, RDFS_LABEL, 'Oh! Ridge'),
    ];
    const options = optionsFor(WEEKEND, all);
    expect(options.map((o) => o.label).sort()).toEqual(['Lake George', 'Oh! Ridge']);
    expect(options.every((o) => o.rulesOut.length === 1)).toBe(true);
  });
});

describe('needsStp — whose claims are colliding', () => {
  it('escalates when BOTH sides are human-attested', () => {
    const a = st(WEEKEND, `${KPRED}has-status`, 'good', { sourceId: 'manual' });
    const b = st(WEEKEND, `${KPRED}has-status`, 'bad', { sourceId: 'manual' });
    expect(needsStp([a, b])).toBe(true);
  });

  it('does NOT escalate a machine-checkable collision — run the check instead', () => {
    const a = st(WEEKEND, `${KPRED}tested-by`, 'src/a.test.ts');
    const b = st(WEEKEND, `${KPRED}tested-by`, 'src/b.test.ts');
    expect(needsStp([a, b])).toBe(false);
  });

  it('a single side is not a conflict', () => {
    expect(needsStp([st(WEEKEND, `${KPRED}has-status`, 'good', { sourceId: 'manual' })])).toBe(false);
  });
});

describe('buildReviewTree', () => {
  const question = st(WEEKEND, `${KPRED}open-question`, 'Lake George or Oh! Ridge?', { id: 'q' });
  const settled = st(WEEKEND, `${KPRED}decided`, 'Two nights, not three.', { id: 'ctx' });
  const judgment = st(WEEKEND, `${KPRED}description`, 'A first trip in years.', { id: 'j' });
  const measurement = st(WEEKEND, `${KPRED}measured`, '5h40m drive from LA.', { id: 'e' });
  const record = st(WEEKEND, `${KPRED}has-file`, 'static/starter-everyday.ttl', { id: 'r' });
  const log = st(WEEKEND, `${KPRED}progress`, 'WIRED 2026-07-01.', { id: 'l' });

  const all = [question, settled, judgment, measurement, record, log];

  it('shows ONE decision and files everything else beneath it by altitude', () => {
    const tree = buildReviewTree(all, all);
    expect(tree.decisions).toHaveLength(1);
    const d = tree.decisions[0];
    expect(d.question.id).toBe('q');
    expect(d.standing.map((s) => s.id)).toEqual(['ctx']);
    expect(d.judgments.map((s) => s.id)).toEqual(['j']);
    expect(d.evidence.map((s) => s.id)).toEqual(['e']);
    expect(d.hidden.map((s) => s.id).sort()).toEqual(['l', 'r']);
  });

  it('does not reuse rejected or superseded facts as live decision context or option costs', () => {
    const rejectedJudgment = st(WEEKEND, `${KPRED}description`, 'A rejected rationale.', {
      id: 'rejected-j', status: 'rejected',
    });
    const optionFact = st('urn:kbase:concept/ev', `${KPRED}part-of`, '', { o: iri(WEEKEND), id: 'part' });
    const rejectedCost = st('urn:kbase:concept/ev', `${KPRED}ruled-out-by`, '', {
      o: iri(LAKE), id: 'rejected-cost', status: 'superseded',
    });

    const tree = buildReviewTree(
      [question],
      [question, judgment, rejectedJudgment, optionFact, rejectedCost],
    );
    const decision = tree.decisions[0];
    expect(decision.judgments.map((item) => item.id)).toEqual(['j']);
    expect(decision.options).toEqual([]);
  });

  it('a settled decision is CONTEXT, never a second item to review', () => {
    const tree = buildReviewTree([settled], [settled]);
    expect(tree.decisions).toHaveLength(0);
  });

  it('counts bookkeeping that hangs off no decision instead of listing it', () => {
    const orphanRecord = st('urn:kbase:concept/other', `${KPRED}has-file`, 'a.ts', { id: 'or' });
    const orphanLog = st('urn:kbase:concept/other', `${KPRED}progress`, 'DONE.', { id: 'ol' });
    const tree = buildReviewTree([orphanRecord, orphanLog], [orphanRecord, orphanLog]);
    expect(tree.decisions).toHaveLength(0);
    expect(tree.suppressed).toEqual({ record: 1, log: 1 });
  });

  it('marks a prose-only question honestly — no options to weigh yet', () => {
    const tree = buildReviewTree(all, all);
    expect(tree.decisions[0].proseOnly).toBe(true);
    expect(tree.decisions[0].options).toHaveLength(0);
  });

  it('flags the contested decision and routes a human/human collision to STP', () => {
    // Two hand-entered statuses on a well-identified entity: a real change of mind.
    const typed = st(WEEKEND, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '', { o: iri('urn:kbase:type/Concept'), id: 't' });
    const label = st(WEEKEND, RDFS_LABEL, 'The weekend', { id: 'lbl' });
    const s1 = st(WEEKEND, `${KPRED}has-status`, 'on', { sourceId: 'manual', id: 'c1' });
    const s2 = st(WEEKEND, `${KPRED}has-status`, 'off', { sourceId: 'manual', id: 'c2' });
    const graph = [question, typed, label, s1, s2, judgment];
    const tree = buildReviewTree(graph, graph);
    expect(tree.decisions[0].contested).toBe(true);
    expect(tree.decisions[0].escalate).toBe('stp');
  });

  it('ranks contested above everything else', () => {
    const q2 = st('urn:kbase:concept/quiet', `${KPRED}open-question`, 'Something calm?', { id: 'q2' });
    const typed = st(WEEKEND, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '', { o: iri('urn:kbase:type/Concept'), id: 't2' });
    const label = st(WEEKEND, RDFS_LABEL, 'The weekend', { id: 'lbl2' });
    const s1 = st(WEEKEND, `${KPRED}has-status`, 'on', { sourceId: 'manual', id: 'd1' });
    const s2 = st(WEEKEND, `${KPRED}has-status`, 'off', { sourceId: 'manual', id: 'd2' });
    const graph = [q2, question, typed, label, s1, s2];
    const tree = buildReviewTree(graph, graph);
    expect(tree.decisions[0].subjectIri).toBe(WEEKEND);
  });

  it('surfaces a forcing event (a deadline decides the subject)', () => {
    const deadline = st('urn:kbase:concept/ev-book-by-wed', `${KPRED}decides`, '', { o: iri(WEEKEND), id: 'dl' });
    const graph = [question, deadline];
    const tree = buildReviewTree(graph, graph);
    expect(tree.decisions[0].forcedBy.map((s) => s.id)).toEqual(['dl']);
  });

  it('caps the roots without hiding the rest silently', () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      st(`urn:kbase:concept/f${i}`, `${KPRED}open-question`, `Q${i}?`, { id: `m${i}` }),
    );
    expect(buildReviewTree(many, many, { maxDecisions: 2 }).decisions).toHaveLength(2);
  });
});

describe('distillationRequest — the model phrases, it never invents', () => {
  it('scopes the model to facts already in the graph, and asks for structure when prose-only', () => {
    const question = st(WEEKEND, `${KPRED}open-question`, 'Lake George or Oh! Ridge?', { id: 'q' });
    const judgment = st(WEEKEND, `${KPRED}description`, 'A first trip in years.', { id: 'j' });
    const tree = buildReviewTree([question, judgment], [question, judgment]);
    const req = distillationRequest(tree.decisions[0]);
    expect(req.task).toBe('structure-options');
    expect(req.question).toBe('Lake George or Oh! Ridge?');
    expect(req.sourceIds).toContain('j');
    // Every fact offered is traceable — nothing is summarized that cannot be checked.
    expect(req.facts.every((f) => req.sourceIds.includes(f.id))).toBe(true);
  });
});

describe('reviewTreeSummary — the honest headline', () => {
  it('says what was hidden and what still has no options', () => {
    const question = st(WEEKEND, `${KPRED}open-question`, 'Which?', { id: 'q' });
    const log = st(WEEKEND, `${KPRED}progress`, 'DONE.', { id: 'l' });
    const orphan = st('urn:kbase:concept/x', `${KPRED}has-file`, 'a.ts', { id: 'o' });
    const s = reviewTreeSummary(buildReviewTree([question, log, orphan], [question, log, orphan]));
    expect(s).toContain('1 decision open');
    expect(s).toContain('prose-only');
    expect(s).toContain('never shown');
  });

  it('says nothing is open when nothing is', () => {
    expect(reviewTreeSummary(buildReviewTree([], []))).toBe('No decisions open.');
  });
});


/**
 * A CONFLICT IS A DECISION THE GRAPH NEVER WROTE DOWN — regression, found by the demo graph
 * 2026-08-19. Roots were open decisions only, so a contested entity carrying no open-question never
 * appeared in the tree at all, despite this module ranking contested above everything else.
 */
describe('implied roots — contested entities with no written question', () => {
  const B = 'urn:kbase:concept/booking-flow';
  const typed = st(B, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', '', { o: iri('urn:kbase:type/Feature'), id: 'bt' });
  const label = st(B, RDFS_LABEL, 'Online booking flow', { id: 'bl' });
  const a = st(B, `${KPRED}has-status`, 'functional', { sourceId: 'manual', id: 'ba', createdAt: 1 });
  const b = st(B, `${KPRED}has-status`, 'scaffolded', { sourceId: 'manual', id: 'bb', createdAt: 2 });
  const evidence = st(B, `${KPRED}measured`, 'Completion rate 31%.', { id: 'be' });
  const graph = [typed, label, a, b, evidence];

  it('synthesizes a root for a conflict nobody wrote a question for', () => {
    const tree = buildReviewTree(graph, graph);
    expect(tree.decisions).toHaveLength(1);
    const d = tree.decisions[0];
    expect(d.impliedBy).toBe('conflict');
    expect(d.contested).toBe(true);
    expect(d.escalate).toBe('stp');
    expect(d.conflictValues?.sort()).toEqual(['functional', 'scaffolded']);
  });

  it('names the incompatible values in a question composed at READ time', () => {
    const d = buildReviewTree(graph, graph).decisions[0];
    const q = questionText(d);
    expect(q).toContain('Nobody wrote this question down');
    expect(q).toContain('functional');
    expect(q).toContain('scaffolded');
    // The synthesized text is never written into the graph as a fact.
    expect(graph.some((s) => s.o.value.includes('Nobody wrote'))).toBe(false);
  });

  it('anchors on the OLDEST side — the claim that stood longest unchallenged', () => {
    expect(buildReviewTree(graph, graph).decisions[0].question.id).toBe('ba');
  });

  it('does NOT synthesize when the subject already has its own question', () => {
    const authored = st(B, `${KPRED}open-question`, 'Rebuild or repair?', { id: 'bq' });
    const tree = buildReviewTree([...graph, authored], [...graph, authored]);
    expect(tree.decisions).toHaveLength(1);
    expect(tree.decisions[0].impliedBy).toBeUndefined();
    expect(tree.decisions[0].contested).toBe(true);
  });

  it('does NOT synthesize for a machine-checkable clash — run the check instead', () => {
    const m1 = st(B, `${KPRED}tested-by`, 'a.test.ts', { id: 'm1' });
    const m2 = st(B, `${KPRED}tested-by`, 'b.test.ts', { id: 'm2' });
    const g = [typed, label, m1, m2];
    expect(buildReviewTree(g, g).decisions).toHaveLength(0);
  });

  it('counts implied roots separately in the headline', () => {
    expect(reviewTreeSummary(buildReviewTree(graph, graph))).toContain('implied by a conflict');
  });
});
