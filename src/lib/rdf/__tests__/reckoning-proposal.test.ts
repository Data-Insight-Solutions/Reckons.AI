import { describe, it, expect } from 'vitest';
import type { Statement } from '../types';
import { resolveCitations } from '../proposal';
import { standingOf } from '../statement-standing';
import { reckoningStatements, readReckoning } from '../reckoning-entity';
import { JOB_STATES } from '../../generation/job-node';
import {
  parseProposalReply, buildProposalRows, mockProposalReply, PROPOSED_JOB_STATE, optionId, proposalRowPrefix,
} from '../reckoning-proposal';

const held = (id: string, o: string): Statement => ({
  id, s: { kind: 'iri', value: 'urn:kbase:concept/sample-company' }, p: { kind: 'iri', value: 'urn:kbase:predicate/makes' },
  o: { kind: 'literal', value: o }, g: { kind: 'iri', value: 'urn:kbase:source/a' },
  sourceId: 'a', status: 'confirmed', confidence: 1, createdAt: 1, updatedAt: 1,
});
const situation = [held('st-1', 'battery software'), held('st-2', 'a mobile app')];
const ids = situation.map((s) => s.id);

const option = (extra: Record<string, unknown> = {}) => ({
  label: 'Try a wordmark', rationale: 'Quick to test.',
  statements: [{ s: 'Sample Company', p: 'brand direction', o: 'Wordmark' }],
  jobs: [{ kind: 'image', params: { prompt: 'A simple wordmark' } }],
  missingInputs: [{ about: 'Sample Company', question: 'Upload an image of the logo' }],
  citations: ['st-1'], ...extra,
});
const reply = (over: Record<string, unknown> = {}) => JSON.stringify({ recommended: 'a', options: [option(), option({ label: 'Refresh it' })], ...over });

describe('parseProposalReply', () => {
  it('accepts a well-formed reply, with a fence and words around it tolerated', () => {
    const r = parseProposalReply('Here you go:\n```json\n' + reply() + '\n```', ids);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.proposal.options).toHaveLength(2); expect(r.proposal.recommendedKey).toBe('a'); }
  });
  it('accepts the mock provider reply', () => {
    expect(parseProposalReply(mockProposalReply(['st-1']), ids).ok).toBe(true);
  });
  const refused: [string, string, RegExp][] = [
    ['not JSON', 'I think you should try something.', /no JSON object/],
    ['broken JSON', '{"options": [', /no JSON object|not valid JSON/],
    ['one option', JSON.stringify({ recommended: 'a', options: [option()] }), /1 option/],
    ['five options', JSON.stringify({ recommended: 'a', options: [1, 2, 3, 4, 5].map(() => option()) }), /5 options|at most 4/],
    ['no recommendation', JSON.stringify({ options: [option(), option()] }), /recommended/i],
    ['recommendation not an option', reply({ recommended: 'd' }), /not one of the options/],
    ['an option that proposes nothing', reply({ options: [option(), option({ statements: [], jobs: [], missingInputs: [] })] }), /proposes nothing/],
    ['an unknown job kind', reply({ options: [option(), option({ jobs: [{ kind: 'shell', params: { prompt: 'rm -rf' } }] })] }), /kind "shell"/],
    ['a job with no prompt', reply({ options: [option(), option({ jobs: [{ kind: 'image', params: {} }] })] }), /prompt/],
    ['a citation outside the situation', reply({ options: [option(), option({ citations: ['st-99'] })] }), /not one of the chosen/],
    ['a statement missing its value', reply({ options: [option(), option({ statements: [{ s: 'A', p: 'b' }] })] }), /value/],
    ['too many statements', reply({ options: [option(), option({ statements: Array(7).fill({ s: 'A', p: 'b', o: 'c' }) })] }), /at most 6/],
  ];
  for (const [name, raw, why] of refused) {
    it(`refuses ${name}, with a reason`, () => {
      const r = parseProposalReply(raw, ids);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(why);
    });
  }
  it('warns, rather than refuses, about an option that cites nothing', () => {
    const r = parseProposalReply(reply({ options: [option({ citations: [] }), option()] }), ids);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toHaveLength(1);
  });
});

function built(raw = reply()) {
  const parsed = parseProposalReply(raw, ids);
  if (!parsed.ok) throw new Error(parsed.reason);
  const rows = reckoningStatements('r1', ids, 'rebrand', 5);
  const all = [...situation, ...rows];
  const reckoning = readReckoning(all, 'r1')!;
  return buildProposalRows(parsed.proposal, { reckoning, at: 9, all, warnings: parsed.warnings });
}

describe('buildProposalRows', () => {
  const b = built();
  const ofOption = (key: string) => b.rows.filter((r) => r.proposalOption === optionId('r1', key));

  it('writes only pending rows and stamps the options with proposalOption', () => {
    expect(b.rows.every((r) => r.status === 'pending')).toBe(true);
    expect(b.rows.some((r) => r.status === 'confirmed' || r.status === 'refined')).toBe(false);
    expect(ofOption('a').length).toBeGreaterThan(0);
    expect(ofOption('b').length).toBeGreaterThan(0);
    const stmt = ofOption('a').find((r) => r.p.value.endsWith('/brand-direction'))!;
    expect(standingOf(stmt)).toBe('proposed');
  });
  it('records each proposed job in a state the queue never reads, with no queued state', () => {
    for (const key of ['a', 'b']) {
      const states = ofOption(key).filter((r) => r.p.value.endsWith('/job-state'));
      expect(states).toHaveLength(1);
      expect(states[0].o.value).toBe(PROPOSED_JOB_STATE);
      expect(JOB_STATES as readonly string[]).not.toContain(PROPOSED_JOB_STATE);
    }
    expect(b.rows.some((r) => r.p.value.endsWith('/job-state') && r.o.value === 'queued')).toBe(false);
  });
  it('writes each missing input as an open question, a partial fact', () => {
    const q = ofOption('a').filter((r) => r.needsObject);
    expect(q).toHaveLength(1);
    expect(q[0].o).toEqual({ kind: 'literal', value: '?' });
    expect(q[0].question).toBe('Upload an image of the logo');
    expect(standingOf(q[0])).toBe('question');
  });
  it('gives the rows the Reckoning record and an id prefix the choice save leaves alone', () => {
    expect(b.rows.every((r) => r.sourceId === 'reckoning-r1' && r.id.startsWith(proposalRowPrefix('r1')))).toBe(true);
  });
  it('keeps the proposal potential, proposed by an agent, with resolvable citations', () => {
    expect(b.proposal.status).toBe('https://schema.org/PotentialActionStatus');
    expect(b.proposal.proposedBy).toBe('reckoning-agent');
    for (const o of b.proposal.options) {
      const resolved = resolveCitations(o.citations, situation);
      expect(resolved).toEqual([{ statementId: 'st-1', state: 'resolved' }]);
    }
  });
  it('links the proposal to the Reckoning entity', () => {
    const link = b.rows.find((r) => r.p.value.endsWith('/proposal'))!;
    expect(link.s.value).toBe('urn:kbase:concept/reckoning-r1');
    expect(link.o.value).toBe('urn:kbase:concept/reckoning-r1-proposal');
  });
  it('drops a group the safety filter refuses, whole, and reports it', () => {
    const bad = parseProposalReply(reply({ options: [option(), option({ statements: [{ s: 'Sample Company', p: 'plan', o: 'We must exterminate all the immigrants' }] })] }), ids);
    if (!bad.ok) throw new Error(bad.reason);
    const rows = reckoningStatements('r1', ids, 'x', 5);
    const all = [...situation, ...rows];
    const out = buildProposalRows(bad.proposal, { reckoning: readReckoning(all, 'r1')!, at: 9, all });
    expect(out.blocked).toHaveLength(1);
    expect(out.blocked[0].what).toMatch(/statement of option B/);
    expect(out.rows.some((r) => r.o.value.includes('exterminate'))).toBe(false);
    // the rest of option B, and all of option A, still land
    expect(out.rows.some((r) => r.proposalOption === optionId('r1', 'b') && r.needsObject)).toBe(true);
  });
  it('drops a job whose prompt the safety filter refuses, without leaving its label behind', () => {
    const bad = parseProposalReply(reply({ options: [option(), option({ jobs: [{ kind: 'image', params: { prompt: 'child pornography collection' } }] })] }), ids);
    if (!bad.ok) throw new Error(bad.reason);
    const rows = reckoningStatements('r1', ids, 'x', 5);
    const all = [...situation, ...rows];
    const out = buildProposalRows(bad.proposal, { reckoning: readReckoning(all, 'r1')!, at: 9, all });
    expect(out.blocked.some((x) => /job of option B/.test(x.what))).toBe(true);
    expect(out.rows.filter((r) => r.proposalOption === optionId('r1', 'b') && r.p.value.endsWith('/job-stage'))).toHaveLength(0);
  });
});

describe('the mock provider and the structured prompt', () => {
  it('answers a structured request with the fixed valid proposal citing a shown id', async () => {
    const { turtleChat, assembleSystemPrompt } = await import('../../integrations/llm/turtle-chat');
    const { PROPOSAL_SYSTEM_PROMPT } = await import('../reckoning-proposal');
    const kbContext = { statementCount: 0, sourceCount: 0, typesPresent: [], untypedEntityCount: 0, manualStatementCount: 0, sampleEntities: [] };
    const r = await turtleChat({ provider: 'mock', apiKey: '', messages: [{ role: 'user', content: '{{st-1}} a\n{{st-2}} b' }], kbContext, customPrompt: PROPOSAL_SYSTEM_PROMPT, purpose: 'structured' });
    const parsed = parseProposalReply(r.message, ids);
    expect(parsed.ok).toBe(true);
    // structured output is data validated downstream, so the remote prompt omits the preamble; converse keeps it
    const remote = (purpose: 'converse' | 'structured') => assembleSystemPrompt({ kbContext, provider: 'claude', purpose });
    expect(remote('converse').length).toBeGreaterThan(remote('structured').length);
  });
});
