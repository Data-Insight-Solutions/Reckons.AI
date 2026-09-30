/**
 * The local panel (F74.7). What is tested is the part the orchestrator TRUSTS without reading:
 * the consensus thresholds. If `aggregate` calls a tie a majority, a coin flip reaches the rename
 * as a decision; if a failed vote counted for agreement, a panel of one working model would report
 * itself unanimous.
 */
import { describe, it, expect } from 'vitest';
import { aggregate, checkAnswer, formatScore, itemPrompt, needsReview, scoreAgainst, summarize, validateTask, type PanelTask, type Vote } from '../local-panel';

const v = (model: string, sense?: string, error?: string): Vote => ({
  model, item: 'i1', ms: 1, ...(sense !== undefined ? { answer: { sense } } : {}), ...(error ? { error } : {}),
});

const task = (over: Partial<PanelTask> = {}): PanelTask => ({
  id: 't',
  instruction: 'Which?',
  answer: { type: 'object', properties: { sense: { type: 'string', enum: ['a', 'b', 'other'] } }, required: ['sense'] },
  agreeOn: 'sense',
  items: [{ id: 'i1', context: 'ctx' }],
  ...over,
});

describe('aggregate — the thresholds the orchestrator acts on unread', () => {
  it('three of three is unanimous', () => {
    const r = aggregate('i1', [v('m1', 'a'), v('m2', 'a'), v('m3', 'a')], 'sense');
    expect(r).toMatchObject({ status: 'unanimous', value: 'a', agreement: 1 });
  });

  it('two of three is a majority, with the winning value', () => {
    const r = aggregate('i1', [v('m1', 'a'), v('m2', 'b'), v('m3', 'a')], 'sense');
    expect(r).toMatchObject({ status: 'majority', value: 'a' });
    expect(r.agreement).toBeCloseTo(2 / 3);
  });

  it('three different answers is a split and names no value', () => {
    const r = aggregate('i1', [v('m1', 'a'), v('m2', 'b'), v('m3', 'other')], 'sense');
    expect(r.status).toBe('split');
    expect(r.value).toBeUndefined();
  });

  it('a tie is a split, never a majority decided by sort order', () => {
    const r = aggregate('i1', [v('m1', 'a'), v('m2', 'b'), v('m3', 'a'), v('m4', 'b')], 'sense');
    expect(r.status).toBe('split');
  });

  it('a failed vote counts AGAINST agreement: one answer plus two errors is not unanimous', () => {
    const r = aggregate('i1', [v('m1', 'a'), v('m2', undefined, 'timeout'), v('m3', undefined, 'bad json')], 'sense');
    expect(r.status).toBe('split');
    expect(r.agreement).toBeCloseTo(1 / 3);
  });

  it('two agreeing answers and one error is a majority, not unanimous', () => {
    const r = aggregate('i1', [v('m1', 'a'), v('m2', 'a'), v('m3', undefined, 'timeout')], 'sense');
    expect(r.status).toBe('majority');
  });

  it('no answers at all is failed', () => {
    expect(aggregate('i1', [v('m1', undefined, 'down')], 'sense').status).toBe('failed');
    expect(aggregate('i1', [], 'sense').status).toBe('failed');
  });
});

describe('validateTask — a malformed task fails before any model is loaded', () => {
  it('accepts a well-formed task', () => {
    expect(validateTask(task())).toEqual([]);
  });

  it('rejects an agreeOn field the schema does not have', () => {
    expect(validateTask(task({ agreeOn: 'meaning' })).join()).toMatch(/agreeOn/);
  });

  it('rejects duplicate item ids, which would merge two sites into one verdict', () => {
    expect(validateTask(task({ items: [{ id: 'x', context: '' }, { id: 'x', context: '' }] })).join()).toMatch(/duplicate/);
  });

  it('rejects an empty batch and a non-object schema', () => {
    const problems = validateTask(task({ items: [], answer: { type: 'string' } })).join();
    expect(problems).toMatch(/items is empty/);
    expect(problems).toMatch(/object schema/);
  });
});

describe('checkAnswer — schema enforced even though Ollama constrains decoding', () => {
  const schema = task().answer;
  it('accepts a valid answer', () => {
    expect(checkAnswer(schema, '{"sense":"a"}')).toEqual({ answer: { sense: 'a' } });
  });
  it('rejects a value outside the enum — an invented meaning', () => {
    expect(checkAnswer(schema, '{"sense":"vertex"}').error).toBeTruthy();
  });
  it('rejects prose', () => {
    expect(checkAnswer(schema, 'The answer is a.').error).toMatch(/not JSON/);
  });
  it('rejects a missing required field, a wrong type, and an over-long reason', () => {
    const s2 = { type: 'object', properties: { sense: { type: 'string' }, n: { type: 'integer' }, reason: { type: 'string', maxLength: 5 } }, required: ['sense'] };
    expect(checkAnswer(s2, '{}').error).toMatch(/missing sense/);
    expect(checkAnswer(s2, '{"sense":"a","n":1.5}').error).toMatch(/n must be integer/);
    expect(checkAnswer(s2, '{"sense":"a","reason":"far too long"}').error).toMatch(/longer than 5/);
    expect(checkAnswer(s2, '[1]').error).toMatch(/object/);
  });
});

describe('prompt and summary', () => {
  it('puts the item id and its context under the same question for every item', () => {
    const p = itemPrompt(task(), { id: 'src/x.ts:4', context: '>> 4 const node = 1' });
    expect(p).toContain('QUESTION\nWhich?');
    expect(p).toContain('ITEM src/x.ts:4');
    expect(p).toContain('const node = 1');
  });

  it('lists splits and failures, and leaves unanimous items to the result file', () => {
    const verdicts = [
      aggregate('ok', [v('m1', 'a'), v('m2', 'a')].map((x) => ({ ...x, item: 'ok' })), 'sense'),
      aggregate('bad', [v('m1', 'a'), v('m2', 'b')].map((x) => ({ ...x, item: 'bad' })), 'sense'),
    ];
    const text = summarize(
      { task: 't', models: ['m1', 'm2'], engine: 'ollama', startedAt: '', ms: 1000, counts: { unanimous: 1, majority: 0, split: 1, failed: 0 }, verdicts },
      'sense',
    );
    expect(text).toMatch(/unanimous 1 · majority 0 · split 1/);
    expect(text).toMatch(/SPLIT bad: m1=a m2=b/);
    expect(text).not.toMatch(/UNANIMOUS ok/);
    expect(text).toMatch(/1 taken \(accept=unanimous\), 1 to review/);
  });
});

describe('the trust policy and scoring', () => {
  const verdict = (item: string, values: string[]) =>
    aggregate(item, values.map((s, i) => ({ ...v(`m${i}`, s), item })), 'sense');

  it('escalates a majority as well as a split — only unanimous is taken unread', () => {
    expect(needsReview(verdict('u', ['a', 'a', 'a']))).toBe(false);
    expect(needsReview(verdict('m', ['a', 'a', 'b']))).toBe(true);
    expect(needsReview(verdict('s', ['a', 'b', 'other']))).toBe(true);
  });

  it('with accept=majority takes majorities too, and still escalates splits', () => {
    expect(needsReview(verdict('m', ['a', 'a', 'b']), 'majority')).toBe(false);
    expect(needsReview(verdict('s', ['a', 'b', 'other']), 'majority')).toBe(true);
  });

  it('scores per status and keeps ambiguous items out of right and wrong', () => {
    const verdicts = [verdict('u1', ['a', 'a', 'a']), verdict('u2', ['b', 'b', 'b']), verdict('m1', ['a', 'a', 'b']), verdict('s1', ['a', 'b', 'other'])];
    const result = { task: 't', models: [], engine: 'ollama' as const, startedAt: '', ms: 0, counts: { unanimous: 2, majority: 1, split: 1, failed: 0 }, verdicts };
    const score = scoreAgainst(result, { u1: 'a', u2: 'a', m1: 'ambiguous', s1: 'b' });
    expect(score.unanimous).toEqual({ correct: 1, wrong: 1, ambiguous: 0, unlabelled: 0 });
    expect(score.majority).toEqual({ correct: 0, wrong: 0, ambiguous: 1, unlabelled: 0 });
    expect(score.split.wrong).toBe(1); // no panel value to match
    expect(formatScore(score)).toMatch(/unanimous correct 1 · wrong 1 · ambiguous 0 {2}\(50% of decidable\)/);
  });
});
