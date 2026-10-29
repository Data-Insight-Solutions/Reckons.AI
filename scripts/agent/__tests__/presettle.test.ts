/**
 * kb:question-presettle done-test: a question is answered by script when its site is gone, by a
 * local model only with citations it was given, and every answer joins the question's decision.
 */
import { describe, it, expect } from 'vitest';
import { groupDecisions } from '../../../mcp-server/src/review-session';
import { siteCheck, validateAnswer, answerRow, citationNote, decidedTriples, candidatesFor, promptFor, type Candidate } from '../presettle';

const files: Record<string, string> = {
  'src/lib/live.ts': 'const a = 1;\n// the node list\nexport const node = 2;\n',
  'src/lib/renamed.ts': 'export const vertex = 1;\n',
};
/** What dev's history says: a deleted file, and a word removed from a file, each by a known commit. */
const probe = {
  read: (p: string) => files[p] ?? null,
  deletedIn: (p: string) => (p === 'src/lib/deleted.ts' ? 'abc1234 2026-10-20' : null),
  wordRemovedIn: (p: string, w: string) => (p === 'src/lib/renamed.ts' && w === 'node' ? 'def5678 2026-10-21' : null),
};

describe('site stage (script)', () => {
  it('a file dev deleted: no longer applies, naming the commit that deleted it', () => {
    const s = siteCheck('Which meaning of "node" is used at src/lib/deleted.ts:12?', probe, '2026-10-28');
    expect(s?.answer).toBe('no longer applies: src/lib/deleted.ts was deleted (abc1234 2026-10-20)');
    expect(s?.evidence).toMatch(/checked 2026-10-28/);
  });
  it('a file that never reached dev (still on a branch) is NOT moot', () => {
    expect(siteCheck('Is scripts/starter/build-research.ts still used?', probe, '2026-10-28')).toBeNull();
  });
  it('a word dev removed from the file: no longer applies, naming the commit', () => {
    const s = siteCheck('Which meaning of "node" is used at src/lib/renamed.ts:1?', probe, '2026-10-28');
    expect(s?.answer).toBe('no longer applies: "node" was removed from src/lib/renamed.ts (def5678 2026-10-21)');
  });
  it('a word that is absent but was never removed on dev (added on a branch) is NOT moot', () => {
    expect(siteCheck('Which meaning of "graph" is used at src/lib/renamed.ts:1?', probe, '2026-10-28')).toBeNull();
  });
  it('a live site gets no answer, even when the word moved to another line', () => {
    expect(siteCheck('Which meaning of "node" is used at src/lib/live.ts:1?', probe, '2026-10-28')).toBeNull();
    expect(siteCheck('Is src/lib/live.ts still used?', probe, '2026-10-28')).toBeNull();
  });
  it('a question that names no site gets no answer', () => {
    expect(siteCheck('Does HomeAssistant stay in the VM?', probe, '2026-10-28')).toBeNull();
  });
});

const given: Candidate[] = [
  { subject: 'urn:kbase:concept/a', text: 'MATT, 2026-10-13: block only on NEW alerts the promotion introduces. Alerts already open on main are a separate backlog.' },
  { subject: 'urn:kbase:concept/b', text: 'MATT, 2026-10-27: an MCP trigger connects only to tool nodes.' },
  { subject: 'urn:kbase:concept/c', text: 'MATT, 2026-10-28: qwen3.8 stays the chat deputy.' },
];
const QUOTE = 'block only on NEW alerts the promotion introduces';

describe('graph stage (agent): the validator', () => {
  it('accepts an answer that cites decisions it was given and quotes the deciding words', () => {
    expect(validateAnswer({ settled: true, answer: 'No', cites: [1, 2], quote: QUOTE }, given)).toBeNull();
    expect(validateAnswer({ settled: false }, given)).toBeNull();
  });
  it('refuses a quote that is not, word for word, in a decision it cited (2026-10-28: 2 of 4 unquoted answers were wrong)', () => {
    expect(validateAnswer({ settled: true, answer: 'No', cites: [1] }, given)).toMatch(/quote/);
    expect(validateAnswer({ settled: true, answer: 'No', cites: [2], quote: QUOTE }, given)).toMatch(/not in a decision it cited/);
    expect(validateAnswer({ settled: true, answer: 'No', cites: [1], quote: 'block every alert on main forever' }, given)).toMatch(/not in a decision it cited/);
    expect(validateAnswer({ settled: true, answer: 'No', cites: [1], quote: 'block' }, given)).toMatch(/too short/);
  });
  it('matches a quote across case and whitespace differences only', () => {
    expect(validateAnswer({ settled: true, answer: 'No', cites: [1], quote: 'Block only on new   alerts the promotion introduces' }, given)).toBeNull();
  });
  it('refuses an answer that cites nothing, or a number it was not given', () => {
    expect(validateAnswer({ settled: true, answer: 'yes', cites: [], quote: QUOTE }, given)).toMatch(/cites no decision/);
    expect(validateAnswer({ settled: true, answer: 'yes', quote: QUOTE }, given)).toMatch(/cites no decision/);
    expect(validateAnswer({ settled: true, answer: 'yes', cites: [4], quote: QUOTE }, given)).toMatch(/not given/);
    expect(validateAnswer({ settled: true, answer: 'yes', cites: [0], quote: QUOTE }, given)).toMatch(/not given/);
    expect(validateAnswer({ settled: true, answer: '', cites: [1], quote: QUOTE }, given)).toMatch(/no answer/);
    expect(validateAnswer({ settled: true, answer: 'x'.repeat(401), cites: [1], quote: QUOTE }, given)).toMatch(/400/);
  });
});

describe('the emitted row', () => {
  const question = { subject: 'urn:kbase:concept/x', predicate: 'urn:kbase:predicate/open-question', type: 'question', kb: 'roadmap', agent: 'term-senses node' };
  const [d] = groupDecisions([question]);
  const cands: Candidate[] = [
    { subject: 'urn:kbase:concept/a', text: "MATT, 2026-10-28: 'qwen3.8 stays the chat deputy.'" },
    { subject: 'urn:kbase:concept/b', text: 'MATT, 2026-10-27: unrelated.' },
  ];
  const row = answerRow(d, 'qwen3.8', 'presettle:graph:qwen3.8:latest', citationNote(cands, [1, 1]), 'presettle-run', '2026-10-28T00:00:00Z');

  it('quotes every cited decision verbatim, once, and only those', () => {
    expect(row.note).toContain(`[kb:a] kpred:decided "${cands[0].text}"`);
    expect(row.note).not.toContain('unrelated');
    expect(row.note.match(/kb:a/g)).toHaveLength(1);
  });
  it('carries answers, the stage as agent, and type suggestion', () => {
    expect(row).toMatchObject({ answers: d.id, agent: 'presettle:graph:qwen3.8:latest', type: 'suggestion', subject: question.subject, predicate: question.predicate, kb: 'roadmap' });
  });
  it('joins the question it answers: still one decision, now with one claim', () => {
    const ds = groupDecisions([question, row]);
    expect(ds).toHaveLength(1);
    expect(ds[0].claims.map((c) => c.object)).toEqual(['qwen3.8']);
  });
});

describe('grounding', () => {
  const ttl = `@prefix kb: <urn:kbase:concept/> . @prefix kpred: <urn:kbase:predicate/> .
kb:deputy kpred:decided "MATT, 2026-10-28: qwen3.8 stays the chat deputy and Sonnet the overseer." ;
  kpred:description "not a decision" .
kb:gate kpred:decided "MATT, 2026-10-28: raise the audit gate to moderate." .`;
  const decided = decidedTriples([{ path: 'static/t.ttl', text: ttl }, { path: 'static/broken.ttl', text: '@prefix nope' }]);
  it('offers only kpred:decided statements, and skips a file that does not parse', () => {
    expect(decided).toHaveLength(2);
    expect(decided.every((t) => t.predicate === 'urn:kbase:predicate/decided')).toBe(true);
  });
  it('ranks the decision that shares the question\'s words first, and numbers it in the prompt', () => {
    const d = { question: 'Which model is the chat deputy?', subject: 'urn:kbase:concept/loop', predicate: 'urn:kbase:predicate/open-question' };
    const c = candidatesFor(d, decided);
    expect(c[0].subject).toBe('urn:kbase:concept/deputy');
    expect(promptFor(d, c)).toMatch(/^1\. \[kb:deputy\] MATT/m);
  });
});
