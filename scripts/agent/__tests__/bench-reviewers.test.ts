import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { buildPrompt, formatTable, loadCases, mentionHits, parseCliJson, parseVerdict, planCalls, rescore, selectModels, summarize, type CaseResult } from '../bench-reviewers';

describe('parseVerdict', () => {
  it('reads plain JSON', () => {
    expect(parseVerdict('{"verdict":"reject","reasons":["noise"]}')).toEqual({ verdict: 'reject', reasons: 'noise' });
  });
  it('tolerates fences and prose, and normalises underscores/case', () => {
    const p = parseVerdict('Sure:\n```json\n{"verdict":"Required_Change","reasons":["fails open","no status check"]}\n```');
    expect(p.verdict).toBe('required-change');
    expect(p.reasons).toBe('fails open no status check');
  });
  it('salvages the verdict from malformed JSON (invalid \\\' escape seen from haiku)', () => {
    const p = parseVerdict('```json\n{"verdict": "accept", "reasons": ["use \'\\\'\' to escape"]}\n```');
    expect(p.verdict).toBe('accept');
    expect(p.reasons).toContain('escape');
  });
  it('rescore fills a null verdict from the saved text without model calls', () => {
    const c = { id: 'x', promptContext: '', expected: { verdict: 'accept' as const, mustMention: ['posix'] } };
    const saved: CaseResult = { caseId: 'x', model: 'haiku', verdict: null, reasons: '{"verdict": "accept", "reasons": ["POSIX \'\\\'\'"]}', verdictCorrect: false, mentionHits: 0, mentionTotal: 1, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: 0, durationMs: 0 } };
    const [r] = rescore([saved], [c]);
    expect(r.verdict).toBe('accept');
    expect(r.verdictCorrect).toBe(true);
    expect(r.mentionHits).toBe(1);
  });
  it('returns a null verdict for an unknown label or non-JSON', () => {
    expect(parseVerdict('{"verdict":"maybe","reasons":[]}').verdict).toBeNull();
    expect(parseVerdict('I think it is fine').verdict).toBeNull();
  });
});

describe('mentionHits', () => {
  it('is case-insensitive substring and counts only listed keywords', () => {
    expect(mentionHits('It FAILS CLOSED badly', ['fail closed', 'status'])).toEqual({ hits: 0, total: 2 });
    expect(mentionHits('should fail closed; check status 1', ['fail closed', 'Status'])).toEqual({ hits: 2, total: 2 });
    expect(mentionHits('x', undefined)).toEqual({ hits: 0, total: 0 });
  });
});

describe('parseCliJson', () => {
  it('maps the CLI result fields', () => {
    const p = parseCliJson(JSON.stringify({ result: 'hi', is_error: false, duration_ms: 1200, total_cost_usd: 0.0123, usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 100, cache_read_input_tokens: 40 } }));
    expect(p).toEqual({ text: 'hi', isError: false, usage: { inputTokens: 5, outputTokens: 7, cacheCreationTokens: 100, cacheReadTokens: 40, costUsd: 0.0123, durationMs: 1200 } });
  });
  it('defaults missing usage to zero', () => {
    expect(parseCliJson('{"result":"x"}').usage.inputTokens).toBe(0);
  });
});

describe('planning', () => {
  it('counts calls and never includes opus unless asked', () => {
    expect(planCalls(7, ['haiku', 'sonnet'], 1)).toBe(14);
    expect(selectModels(undefined, false)).toEqual(['haiku', 'sonnet']);
    expect(selectModels('haiku,opus', false)).toEqual(['haiku']);
    expect(selectModels(undefined, true)).toEqual(['haiku', 'sonnet', 'opus']);
  });
});

describe('summarize', () => {
  const u = (i: number, o: number, c: number, ms: number) => ({ inputTokens: i, outputTokens: o, cacheCreationTokens: 0, cacheReadTokens: 0, costUsd: c, durationMs: ms });
  const r = (caseId: string, model: string, verdict: any, ok: boolean, h: number, t: number): CaseResult => ({ caseId, model, verdict, reasons: '', verdictCorrect: ok, mentionHits: h, mentionTotal: t, usage: u(100, 10, 0.01, 1000) });
  it('scores accuracy, mention rate, unparsed and misses per model', () => {
    const exp = new Map([['a', 'accept' as const], ['b', 'reject' as const]]);
    const s = summarize([r('a', 'haiku', 'accept', true, 0, 0), r('b', 'haiku', null, false, 0, 2), r('a', 'sonnet', 'accept', true, 0, 0), r('b', 'sonnet', 'reject', true, 2, 2)], exp);
    const h = s.find((x) => x.model === 'haiku')!;
    expect(h.verdictAccuracy).toBe(0.5);
    expect(h.unparsed).toBe(1);
    expect(h.misses).toEqual([{ caseId: 'b', expected: 'reject', got: null }]);
    expect(s.find((x) => x.model === 'sonnet')!.mentionRate).toBe(1);
    expect(formatTable(s)).toContain('haiku');
  });
});

describe('fixtures', () => {
  const cases = loadCases(path.resolve(__dirname, '../fixtures/reviewer-bench'));
  it('has at least 6 cases, unique ids, valid verdicts, and each under ~4k tokens', () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    for (const c of cases) {
      expect(['accept', 'reject', 'required-change']).toContain(c.expected.verdict);
      expect(buildPrompt(c).length / 4).toBeLessThan(4000);
    }
  });
  it('covers all three verdicts', () => {
    expect(new Set(cases.map((c) => c.expected.verdict)).size).toBe(3);
  });
});
