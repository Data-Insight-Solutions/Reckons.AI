/**
 * F139.1 cascade aggregation — aggregate the noise, ask ONE question, settle all of it.
 *
 * The deterministic bases are the floor (mechanical batches, free, exact). The validator is what
 * makes the AGENT tier safe, so most of these tests are rejections: a model may choose which value
 * to record and how to phrase the question, and may never introduce a value the facts do not hold.
 */
import { describe, it, expect } from 'vitest';
import {
  clusterForCascade, applyCascade, cascadeSummary,
  validateProposedAggregation, aggregationRequest,
  needsPurposeQuestion, purposeQuestion,
  validateProposedPartition, applyPartition, slugifyPurpose,
  type ProposedAggregation, type ProposedPartition,
} from '../fact-aggregation';
import type { Statement } from '../types';

const KPRED = 'urn:kbase:predicate/';
let n = 0;
function st(s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: extra.id ?? `s${n}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: extra.sourceId ?? 'x',
    confidence: 1,
    status: 'pending',
    createdAt: n,
    updatedAt: n,
    ...extra,
  } as Statement;
}

const F = (i: number) => `urn:kbase:concept/feature-${i}`;

describe('clusterForCascade — the deterministic floor', () => {
  it("Matt's case: many datestamps become ONE question", () => {
    const facts = [
      st(F(1), `${KPRED}progress`, 'WIRED 2026-08-16. Added the resolver.', { id: 'a' }),
      st(F(1), `${KPRED}done`, 'SHIPPED 2026-08-16. Editor landed.', { id: 'b' }),
      st(F(1), `${KPRED}progress`, 'FIXED 2026-08-16. Lint clean.', { id: 'c' }),
      st(F(1), `${KPRED}progress`, 'DONE 2026-08-16. Tests green.', { id: 'd' }),
    ];
    const [cluster] = clusterForCascade(facts);
    expect(cluster.basis).toBe('same-date');
    expect(cluster.members).toHaveLength(4);
    expect(cluster.question).toContain('2026-08-16');
    expect(cluster.question).toMatch(/\?$/);
    expect(cluster.proposes.object).toBe('2026-08-16');
  });

  it('a fact joins at most one cluster, so two answers can never settle it differently', () => {
    const facts = [
      st(F(1), `${KPRED}progress`, 'DONE 2026-08-16.', { id: 'a', sourceId: 'src1' }),
      st(F(2), `${KPRED}progress`, 'DONE 2026-08-16.', { id: 'b', sourceId: 'src1' }),
      st(F(3), `${KPRED}progress`, 'DONE 2026-08-16.', { id: 'c', sourceId: 'src1' }),
    ];
    const clusters = clusterForCascade(facts);
    const seen = clusters.flatMap((c) => c.members.map((m) => m.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('same-source excludes EVIDENCE — a weak claim must not settle a strong fact', () => {
    // Regression 2026-08-19: allowing evidence in put 61 demo facts into one "do you trust this
    // source?" question including every measurement. Evidence sits above record/log in the altitude
    // ordering precisely because a measurement can pull a judgment out from under itself.
    const facts = [
      st(F(1), `${KPRED}relates-to`, 'urn:x', { id: 'r1', sourceId: 'src1' }),
      st(F(2), `${KPRED}relates-to`, 'urn:x', { id: 'r2', sourceId: 'src1' }),
      st(F(3), `${KPRED}relates-to`, 'urn:x', { id: 'r3', sourceId: 'src1' }),
      st(F(4), `${KPRED}measured`, 'Completion rate 31%.', { id: 'e1', sourceId: 'src1' }),
      st(F(5), `${KPRED}measured`, 'Hosting quote $49/month.', { id: 'e2', sourceId: 'src1' }),
    ];
    const clusters = clusterForCascade(facts);
    const members = clusters.flatMap((c) => c.members.map((m) => m.id));
    expect(members).toEqual(expect.arrayContaining(['r1', 'r2', 'r3']));
    expect(members).not.toContain('e1');
    expect(members).not.toContain('e2');
    expect(clusters[0].question).toContain('no measurements');
  });

  it('will not make a cluster too small to be worth a question', () => {
    expect(clusterForCascade([st(F(1), `${KPRED}progress`, 'DONE 2026-08-16.')])).toHaveLength(0);
  });

  it('never clusters a decision — that is the thing being asked', () => {
    const decisions = [
      st(F(1), `${KPRED}open-question`, 'A or B? 2026-08-16', { id: 'a' }),
      st(F(2), `${KPRED}decided`, 'Chose A. 2026-08-16', { id: 'b' }),
      st(F(3), `${KPRED}principle`, 'Never batch. 2026-08-16', { id: 'c' }),
    ];
    expect(clusterForCascade(decisions)).toHaveLength(0);
  });
});

describe('applyCascade — one answer, recorded once, propagated with provenance', () => {
  const facts = [
    st(F(1), `${KPRED}progress`, 'WIRED 2026-08-16.', { id: 'a' }),
    st(F(1), `${KPRED}progress`, 'FIXED 2026-08-16.', { id: 'b' }),
    st(F(1), `${KPRED}progress`, 'DONE 2026-08-16.', { id: 'c' }),
  ];
  const [cluster] = clusterForCascade(facts);

  it("records the USER'S own fact, labelled as their attestation", () => {
    const r = applyCascade(cluster, 'confirm', { actor: 'matt', channel: 'app:review', at: 1000 });
    expect(r.recorded.o.value).toBe('2026-08-16');
    expect(r.recorded.status).toBe('confirmed');
    // Nothing but their word backs it, and it says so rather than blending in with measurements.
    expect(r.recorded.verifiableBy).toBe('user');
    expect(r.recorded.sourceId).toBe('manual');
    expect(r.recorded.settledBy).toEqual({ actor: 'matt', channel: 'app:review', at: 1000 });
  });

  it('cascades to every member, each traceable back to the one decision', () => {
    const r = applyCascade(cluster, 'confirm', { actor: 'matt', channel: 'cli', at: 1000 });
    expect(r.updated).toHaveLength(3);
    expect(r.updated.every((s) => s.status === 'confirmed')).toBe(true);
    expect(new Set(r.updated.map((s) => s.settledByDecision)).size).toBe(1);
    expect(r.updated[0].settledByDecision).toBe(r.recorded.id);
  });

  it('"no" rejects the batch rather than confirming it', () => {
    const r = applyCascade(cluster, 'reject', { actor: 'matt', channel: 'cli' });
    expect(r.updated.every((s) => s.status === 'rejected')).toBe(true);
    expect(r.effect).toContain('rejected 3 facts');
  });

  it('a correction records the corrected value and supersedes the members', () => {
    const r = applyCascade(cluster, 'correct', { actor: 'matt', channel: 'cli', correctedObject: '2026-08-17' });
    expect(r.recorded.o.value).toBe('2026-08-17');
    expect(r.updated.every((s) => s.status === 'superseded')).toBe(true);
  });

  it('refuses to batch-settle decision-altitude facts even if handed one', () => {
    const bad = { ...cluster, altitude: 'decision' as const };
    expect(() => applyCascade(bad, 'confirm', { actor: 'matt', channel: 'cli' })).toThrow(/refusing/);
  });
});

describe('validateProposedAggregation — the harness that makes the agent tier safe', () => {
  const facts = [
    st(F(1), `${KPRED}progress`, 'WIRED 2026-08-16. Resolver added.', { id: 'a' }),
    st(F(2), `${KPRED}progress`, 'FIXED 2026-08-16. Lint clean.', { id: 'b' }),
    st(F(3), `${KPRED}progress`, 'DONE 2026-08-16. Tests green.', { id: 'c' }),
    st(F(4), `${KPRED}has-status`, 'functional', { id: 'j' }),
  ];
  const open = [{ id: 'd1', subject: F(1), question: 'Which storage shape?' }];
  const req = aggregationRequest(facts, open);

  const good: ProposedAggregation = {
    clusters: [{
      memberIds: ['a', 'b', 'c'],
      question: 'Did this work occur on 2026-08-16?',
      proposes: { subject: 'urn:kbase:concept/work', predicate: `${KPRED}work-occurred-on`, object: '2026-08-16' },
      rationale: 'three completion notes sharing one date',
    }],
    dependencies: [],
  };

  it('accepts a well-formed, fully traceable proposal', () => {
    const out = validateProposedAggregation(good, req, facts);
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0].basis).toBe('semantic');
    expect(out.rejected).toEqual([]);
  });

  it('REJECTS an invented value — one hallucination must not settle three facts', () => {
    const bad: ProposedAggregation = {
      clusters: [{ ...good.clusters[0], proposes: { ...good.clusters[0].proposes, object: '2026-09-01' } }],
      dependencies: [],
    };
    const out = validateProposedAggregation(bad, req, facts);
    expect(out.clusters).toHaveLength(0);
    expect(out.rejected[0]).toContain('appears in none of its');
  });

  it('rejects fact ids that were never in the request', () => {
    const bad: ProposedAggregation = {
      clusters: [{ ...good.clusters[0], memberIds: ['a', 'b', 'ghost'] }],
      dependencies: [],
    };
    expect(validateProposedAggregation(bad, req, facts).rejected[0]).toContain('not in the request');
  });

  it('withholds judgment facts from the model entirely — the first line of defense', () => {
    // aggregationRequest never offers them, so a model cannot propose batching a verdict even
    // if it wanted to: the id comes back as one that was never in the request.
    const bad: ProposedAggregation = {
      clusters: [{
        memberIds: ['a', 'b', 'j'],
        question: 'Are these all done?',
        proposes: { subject: 'urn:kbase:concept/w', predicate: `${KPRED}work-occurred-on`, object: 'functional' },
      }],
      dependencies: [],
    };
    expect(validateProposedAggregation(bad, req, facts).rejected[0]).toContain('not in the request');
  });

  it('rejects a judgment even when a caller offers one — the second line of defense', () => {
    // Defense in depth: a call site that builds its own request (or a future basis) must still not
    // be able to clear a qualitative verdict in bulk.
    const looseReq = {
      facts: facts.map((s) => ({ id: s.id, subject: s.s.value, predicate: s.p.value, object: s.o.value })),
      openDecisions: open,
    };
    const bad: ProposedAggregation = {
      clusters: [{
        memberIds: ['a', 'b', 'j'],
        question: 'Are these all functional?',
        proposes: { subject: 'urn:kbase:concept/w', predicate: `${KPRED}has-status`, object: 'functional' },
      }],
      dependencies: [],
    };
    expect(validateProposedAggregation(bad, looseReq, facts).rejected[0]).toContain('judgment-altitude');
  });

  it('rejects overlapping clusters so no fact is settled twice', () => {
    const bad: ProposedAggregation = {
      clusters: [good.clusters[0], { ...good.clusters[0], question: 'Did the same work occur on 2026-08-16?' }],
      dependencies: [],
    };
    const out = validateProposedAggregation(bad, req, facts);
    expect(out.clusters).toHaveLength(1);
    expect(out.rejected[0]).toContain('already claimed');
  });

  it('rejects output that is not actually a question', () => {
    const bad: ProposedAggregation = {
      clusters: [{ ...good.clusters[0], question: 'These are all from August.' }],
      dependencies: [],
    };
    expect(validateProposedAggregation(bad, req, facts).rejected[0]).toContain('not a question');
  });

  it('rejects an invented predicate vocabulary', () => {
    const bad: ProposedAggregation = {
      clusters: [{ ...good.clusters[0], proposes: { ...good.clusters[0].proposes, predicate: 'https://evil.example/p' } }],
      dependencies: [],
    };
    expect(validateProposedAggregation(bad, req, facts).rejected[0]).toContain('outside the graph');
  });

  it('accepts a dependency between two real open decisions, rejects invented ones', () => {
    const open2 = [...open, { id: 'd2', subject: F(2), question: 'Which archive shape?' }];
    const req2 = aggregationRequest(facts, open2);
    const p: ProposedAggregation = {
      clusters: [],
      dependencies: [
        { blocker: 'd1', blocked: 'd2', because: 'storage shape decides the archive shape' },
        { blocker: 'd1', blocked: 'ghost' },
        { blocker: 'd1', blocked: 'd1' },
      ],
    };
    const out = validateProposedAggregation(p, req2, facts);
    expect(out.dependencies).toHaveLength(1);
    expect(out.dependencies[0].because).toContain('archive shape');
    expect(out.rejected).toHaveLength(2);
  });

  it('reports every rejection rather than silently dropping it', () => {
    const bad: ProposedAggregation = {
      clusters: [
        { ...good.clusters[0], memberIds: ['ghost'] },
        { ...good.clusters[0], question: 'nope' },
      ],
      dependencies: [{ blocker: 'x', blocked: 'y' }],
    };
    // Rejection rate is the measurement that decides whether this tier is worth running.
    expect(validateProposedAggregation(bad, req, facts).rejected).toHaveLength(3);
  });

  it('sends only bare facts to the model — no gloss for it to parrot back', () => {
    expect(req.facts.every((f) => Object.keys(f).sort().join(',') === 'id,object,predicate,subject')).toBe(true);
    // Judgment/decision facts are not even offered for aggregation.
    expect(req.facts.map((f) => f.id)).not.toContain('j');
  });
});

describe('cascadeSummary', () => {
  it('states the saving and whether the groupings were computed or guessed', () => {
    const facts = [
      st(F(1), `${KPRED}progress`, 'DONE 2026-08-16.', { id: 'a' }),
      st(F(1), `${KPRED}progress`, 'WIRED 2026-08-16.', { id: 'b' }),
      st(F(1), `${KPRED}progress`, 'FIXED 2026-08-16.', { id: 'c' }),
    ];
    const s = cascadeSummary(clusterForCascade(facts));
    expect(s).toContain('1 question settles 3 facts');
    expect(s).toContain('computed rather than guessed');
  });

  it('is honest when there is nothing worth batching', () => {
    expect(cascadeSummary([])).toContain('no cluster of noise big enough');
  });
});


/* ────────────────────────────────────────────────────────────────────────────
 * Matt's scenario, 2026-08-19: the answer RESTRUCTURES the set.
 *
 * "What if the question is, 'what is the main goal of this set of work?' … The user may reply, this
 * work consisted of a package update and debugging. The fact set that was defined before the user
 * response should be adjusted to two sets, and the package upgrade itself labelled appropriately,
 * and the debugging after also labeled appropriately with their purpose."
 * ──────────────────────────────────────────────────────────────────────────── */
describe('purpose questions and semantic re-partition', () => {
  const W = 'urn:kbase:concept/unplanned-work';
  const facts = [
    st(W, `${KPRED}progress`, 'BUILT 2026-08-16. Bumped vite to 8.0 and rolldown options renamed.', { id: 'p1' }),
    st(W, `${KPRED}progress`, 'DONE 2026-08-16. Raised the Kit floor and refreshed the lockfile.', { id: 'p2' }),
    st(W, `${KPRED}progress`, 'FIXED 2026-08-16. Traced the failing Storybook build to a stale addon.', { id: 'd1' }),
    st(W, `${KPRED}progress`, 'RESOLVED 2026-08-16. Chased the peer-invalid tree to its root and cleared it.', { id: 'd2' }),
  ];
  const [cluster] = clusterForCascade(facts);
  const ANSWER = 'This work consisted of a package update and debugging.';

  it('asks for PURPOSE when the work is tied to no planned feature', () => {
    expect(needsPurposeQuestion(cluster, () => false)).toBe(true);
    expect(purposeQuestion(cluster)).toContain('main goal');
    // Anchored work already has its purpose — the feature it belongs to.
    expect(needsPurposeQuestion(cluster, () => true)).toBe(false);
  });

  const good: ProposedPartition = {
    parts: [
      { purpose: 'package update', memberIds: ['p1', 'p2'] },
      { purpose: 'debugging', memberIds: ['d1', 'd2'] },
    ],
  };

  it('splits one cluster into two labelled sets, from the answer alone', () => {
    const out = validateProposedPartition(good, cluster, ANSWER);
    expect(out.rejected).toEqual([]);
    expect(out.parts.map((p) => p.purpose)).toEqual(['package update', 'debugging']);
    expect(out.parts.map((p) => p.slug)).toEqual(['package-update', 'debugging']);
    expect(out.parts[0].members.map((m) => m.id)).toEqual(['p1', 'p2']);
  });

  it('REJECTS an invented purpose — the model draws the lines, the person writes the labels', () => {
    const bad: ProposedPartition = {
      parts: [
        { purpose: 'security remediation', memberIds: ['p1', 'p2'] },
        { purpose: 'debugging', memberIds: ['d1', 'd2'] },
      ],
    };
    const out = validateProposedPartition(bad, cluster, ANSWER);
    expect(out.parts).toEqual([]);
    expect(out.rejected.join(' ')).toContain('invented word(s): security, remediation');
  });

  it('REJECTS a non-exhaustive partition rather than silently dropping facts', () => {
    const bad: ProposedPartition = { parts: [{ purpose: 'package update', memberIds: ['p1', 'p2'] }] };
    const out = validateProposedPartition(bad, cluster, ANSWER);
    expect(out.parts).toEqual([]);
    expect(out.rejected.join(' ')).toContain('not exhaustive');
  });

  it('REJECTS overlapping parts — two purposes on one fact is a contradiction, not a partition', () => {
    const bad: ProposedPartition = {
      parts: [
        { purpose: 'package update', memberIds: ['p1', 'p2', 'd1'] },
        { purpose: 'debugging', memberIds: ['d1', 'd2'] },
      ],
    };
    expect(validateProposedPartition(bad, cluster, ANSWER).rejected.join(' ')).toContain('disjoint');
  });

  it('rejects a single part — that is a confirm with a purpose, not a partition', () => {
    const one: ProposedPartition = { parts: [{ purpose: 'package update', memberIds: ['p1', 'p2', 'd1', 'd2'] }] };
    expect(validateProposedPartition(one, cluster, ANSWER).rejected.join(' ')).toContain('not a partition');
  });

  it('records each purpose as the USER\'S own statement and files every fact under one', () => {
    const out = validateProposedPartition(good, cluster, ANSWER);
    const r = applyPartition(out, cluster, ANSWER, { actor: 'matt', channel: 'app:review', at: 500 });

    const purposes = r.recorded.filter((x) => x.p.value === `${KPRED}purpose`);
    expect(purposes.map((x) => x.o.value)).toEqual(['package update', 'debugging']);
    expect(purposes.every((x) => x.verifiableBy === 'user' && x.sourceId === 'manual')).toBe(true);
    expect(purposes[0].settledBy).toEqual({ actor: 'matt', channel: 'app:review', at: 500 });

    // Every original fact is now under exactly one work unit.
    const links = r.recorded.filter((x) => x.p.value === `${KPRED}part-of`);
    expect(links).toHaveLength(4);
    expect(new Set(links.map((l) => l.o.value)).size).toBe(2);
    expect(r.updated).toHaveLength(4);
    expect(r.updated.every((u) => u.status === 'confirmed' && u.settledByDecision)).toBe(true);
    expect(r.effect).toContain('split 4 facts into 2 sets');
  });

  it('refuses to apply a partition that did not validate', () => {
    expect(() => applyPartition({ parts: [], rejected: [] }, cluster, ANSWER, { actor: 'm', channel: 'c' })).toThrow(/nothing validated/);
  });

  it('slugs purposes safely', () => {
    expect(slugifyPurpose('Package Update / deps!')).toBe('package-update-deps');
    expect(slugifyPurpose('   ')).toBe('unlabelled');
  });
});
