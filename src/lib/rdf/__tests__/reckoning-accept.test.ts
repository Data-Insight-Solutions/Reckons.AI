import { describe, it, expect } from 'vitest';
import type { Statement } from '../types';
import { ACTION_STATUS, advanceProposal } from '../proposal';
import { reckoningStatements, readReckoning } from '../reckoning-entity';
import { parseProposalReply, buildProposalRows, optionId, PROPOSED_JOB_STATE } from '../reckoning-proposal';
import {
  readStoredProposal, acceptOption, rejectOption, describeAccept, settleIfReached, optionState, reckoningOfOption,
} from '../reckoning-accept';

const held = (id: string, o: string): Statement => ({
  id, s: { kind: 'iri', value: 'urn:kbase:concept/sample-company' }, p: { kind: 'iri', value: 'urn:kbase:predicate/makes' },
  o: { kind: 'literal', value: o }, g: { kind: 'iri', value: 'urn:kbase:source/a' },
  sourceId: 'a', status: 'confirmed', confidence: 1, createdAt: 1, updatedAt: 1,
});
// the open question the person chose as the target: what does the company still need?
const question: Statement = {
  ...held('q-1', '?'), p: { kind: 'iri', value: 'urn:kbase:predicate/needs-input' }, status: 'pending', needsObject: true, question: 'What is missing?',
};
const situation = [held('st-1', 'battery software'), question];
const opt = (label: string, extra: Record<string, unknown> = {}) => ({
  label, rationale: 'why', citations: ['st-1'],
  statements: [{ s: 'Sample Company', p: 'brand direction', o: label }],
  jobs: [{ kind: 'image', params: { prompt: `A logo: ${label}` } }],
  missingInputs: [{ about: 'Sample Company', question: 'Upload the logo' }], ...extra,
});

function world() {
  const parsed = parseProposalReply(JSON.stringify({ recommended: 'a', options: [opt('Wordmark'), opt('Refresh')] }), ['st-1']);
  if (!parsed.ok) throw new Error(parsed.reason);
  const target = { statementId: 'q-1', assetType: null, note: '' };
  const base = [...situation, ...reckoningStatements('r1', ['st-1'], 'rebrand', 5, target)];
  const reckoning = readReckoning(base, 'r1')!;
  const built = buildProposalRows(parsed.proposal, { reckoning, at: 9, all: base });
  return [...base, ...built.rows];
}
const A = optionId('r1', 'a');
const B = optionId('r1', 'b');
const byId = (all: Statement[]) => new Map(all.map((s) => [s.id, s]));

describe('readStoredProposal', () => {
  it('reads the options, recommendation, target and a potential status back from the rows', () => {
    const stored = readStoredProposal(world(), 'r1')!;
    expect(stored.proposal.options.map((o) => o.id)).toEqual([A, B]);
    expect(stored.proposal.recommendedId).toBe(A);
    expect(stored.proposal.status).toBe(ACTION_STATUS.potential);
    expect(stored.proposal.targetShape?.requirements).toEqual([{ s: 'urn:kbase:concept/sample-company', p: 'urn:kbase:predicate/needs-input' }]);
    expect(stored.statusRowId).toBeTruthy();
    expect(stored.proposal.options[0].citations).toEqual(['st-1']);
  });
  it('is null when nothing was proposed', () => {
    expect(readStoredProposal(situation, 'r1')).toBeNull();
  });
  it('parses the option id back to its Reckoning', () => {
    expect(reckoningOfOption(A)).toBe('r1');
    expect(reckoningOfOption('nonsense')).toBeNull();
  });
});

describe('acceptOption', () => {
  const all = world();
  const stored = readStoredProposal(all, 'r1')!;
  const r = acceptOption(stored.proposal, A, all, stored.statusRowId);
  if (!r.ok) throw new Error(r.message);
  const { plan } = r;
  const rows = byId(all);

  it('confirms the option\'s statement, its job record and metadata, but not its open question', () => {
    const st = plan.confirm.map((id) => rows.get(id)!);
    expect(st.some((x) => x.p.value.endsWith('/brand-direction'))).toBe(true);
    expect(st.every((x) => x.proposalOption === A && !x.needsObject)).toBe(true);
  });
  it('hands the option\'s one job over as plan items, in a state that moves from proposed', () => {
    expect(plan.jobs).toHaveLength(1);
    expect(plan.jobs[0].item).toEqual({ stage: 'image', prompt: 'A logo: Wordmark' });
    expect(rows.get(plan.jobs[0].stateRowId)!.o.value).toBe(PROPOSED_JOB_STATE);
    expect(plan.confirm).not.toContain(plan.jobs[0].stateRowId);
  });
  it('supersedes every row of the other option and none of this one', () => {
    expect(plan.supersede.length).toBeGreaterThan(0);
    expect(plan.supersede.every((id) => rows.get(id)!.proposalOption === B)).toBe(true);
    expect(plan.supersede.some((id) => rows.get(id)!.needsObject)).toBe(true);
  });
  it('leaves the missing-input question open', () => {
    expect(plan.stillOpen).toHaveLength(1);
    expect(rows.get(plan.stillOpen[0])!.needsObject).toBe(true);
    expect(plan.confirm).not.toContain(plan.stillOpen[0]);
  });
  it('makes the proposal active, by the person', () => {
    expect(plan.proposal.status).toBe(ACTION_STATUS.active);
  });
  it('says plainly what will happen', () => {
    const text = describeAccept(plan);
    expect(text).toMatch(/confirm \d+ statements?/);
    expect(text).toMatch(/queue 1 job in one approval/);
    expect(text).toMatch(/superseded/);
    expect(text).toMatch(/1 missing-input question stays open/);
  });
  it('refuses a proposal already decided, and an option that is not one of its options', () => {
    const active = advanceProposal(stored.proposal, ACTION_STATUS.active, { person: true });
    if (!active.ok) throw new Error('setup');
    expect(acceptOption(active.proposal, A, all).ok).toBe(false);
    expect(acceptOption(stored.proposal, 'reckoning-r1-option-z', all).ok).toBe(false);
  });
  it('refuses, changing nothing, when a proposed job record cannot be read back', () => {
    const broken = all.filter((st) => !(st.proposalOption === A && st.p.value.endsWith('/job-stage')));
    const again = readStoredProposal(broken, 'r1')!;
    const out = acceptOption(again.proposal, A, broken);
    expect(out.ok).toBe(false);
  });
});

describe('rejectOption', () => {
  it('rejects only that option\'s pending rows and leaves the proposal waiting', () => {
    const all = world();
    const stored = readStoredProposal(all, 'r1')!;
    const out = rejectOption(stored.proposal, B, all);
    if (!out.ok) throw new Error(out.message);
    expect(out.plan.reject.length).toBeGreaterThan(0);
    expect(out.plan.reject.every((id) => all.find((s) => s.id === id)!.proposalOption === B)).toBe(true);
  });
});

describe('closing: settleIfReached wires closeIfReached', () => {
  const accepted = () => {
    let all = world();
    const stored = readStoredProposal(all, 'r1')!;
    const r = acceptOption(stored.proposal, A, all, stored.statusRowId);
    if (!r.ok) throw new Error(r.message);
    const ids = new Set([...r.plan.confirm, ...r.plan.jobs.map((j) => j.stateRowId)]);
    const sup = new Set(r.plan.supersede);
    all = all.map((s) => (ids.has(s.id) ? { ...s, status: 'confirmed' as const } : sup.has(s.id) ? { ...s, status: 'superseded' as const } : s));
    // the status row now says active
    all = all.map((s) => (s.id === stored.statusRowId ? { ...s, o: { kind: 'iri' as const, value: ACTION_STATUS.active } } : s));
    return { all, r };
  };
  it('does not close while the question is unanswered', () => {
    const { all } = accepted();
    const stored = readStoredProposal(all, 'r1')!;
    const out = settleIfReached(stored, all);
    expect(stored.proposal.status).toBe(ACTION_STATUS.active);
    expect(out.closed).toBe(false);
    expect(out.proposal.status).toBe(ACTION_STATUS.active);
  });
  it('closes once the missing input is answered and confirmed', () => {
    const { all, r } = accepted();
    const qid = r.plan.stillOpen[0];
    const answered = all.map((s) => (s.id === qid ? { ...s, o: { kind: 'literal' as const, value: 'logo.png' }, needsObject: false, status: 'confirmed' as const } : s));
    const out = settleIfReached(readStoredProposal(answered, 'r1')!, answered);
    expect(out.closed).toBe(true);
    expect(out.proposal.status).toBe(ACTION_STATUS.completed);
  });
  it('never closes a proposal still waiting for a decision', () => {
    const all = world();
    const answered = all.map((s) => (s.needsObject && s.proposalOption === A ? { ...s, o: { kind: 'literal' as const, value: 'x' }, needsObject: false, status: 'confirmed' as const } : s));
    const out = settleIfReached(readStoredProposal(answered, 'r1')!, answered);
    expect(out.closed).toBe(false);
  });
});

describe('optionState', () => {
  it('follows the option type row', () => {
    const all = world();
    expect(optionState(all, 'r1', A)).toBe('proposed');
    const typeRow = all.find((s) => s.proposalOption === A && s.p.value.endsWith('22-rdf-syntax-ns#type'))!;
    for (const [status, want] of [['confirmed', 'accepted'], ['rejected', 'rejected'], ['superseded', 'superseded']] as const) {
      expect(optionState(all.map((s) => (s.id === typeRow.id ? { ...s, status } : s)), 'r1', A)).toBe(want);
    }
  });
});
