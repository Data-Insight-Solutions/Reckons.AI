/**
 * Source validation (F100) — check a fact against the open web.
 *
 * The feature earns its keep on ONE verdict: 'mixed', when independent sources disagree — the
 * contradiction the graph could not see from inside itself. If that ever silently collapses into
 * 'supported' (the optimistic failure) the tool stops doing the one thing the thesis needs it to
 * do, so it is pinned here, alongside the guarantee that a neutral source counts as evidence of
 * nothing and that the harness never throws on an empty or broken search.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildValidationQuery,
  verdictFromJudgments,
  validateFact,
  type SourceJudgment,
  type FactRef,
} from '../source-validation';

const j = (stance: SourceJudgment['stance'], confidence = 0.8): SourceJudgment => ({
  url: 'u', title: 't', snippet: 's', stance, confidence,
});

describe('buildValidationQuery', () => {
  it('humanizes IRIs into a plain natural query', () => {
    const q = buildValidationQuery({ subject: 'urn:kbase:concept/marie-curie', predicate: 'urn:kbase:predicate/won-prize', object: 'urn:kbase:concept/nobel-physics' });
    expect(q).toBe('marie curie won prize nobel physics');
  });
  it('quotes a multi-word literal object', () => {
    expect(buildValidationQuery({ subject: 'urn:x', predicate: 'urn:p', object: 'a long spanning phrase', subjectLabel: 'X', predicateLabel: 'is' }))
      .toBe('X is "a long spanning phrase"');
  });
});

describe('verdictFromJudgments', () => {
  it('flags disagreement as MIXED — the whole point', () => {
    const r = verdictFromJudgments([j('supports'), j('contradicts')]);
    expect(r.verdict).toBe('mixed');
    expect(r.supporting).toHaveLength(1);
    expect(r.conflicting).toHaveLength(1);
  });
  it('is supported / contradicted / unverified in the clean cases', () => {
    expect(verdictFromJudgments([j('supports'), j('supports')]).verdict).toBe('supported');
    expect(verdictFromJudgments([j('contradicts')]).verdict).toBe('contradicted');
    expect(verdictFromJudgments([j('neutral'), j('neutral')]).verdict).toBe('unverified');
  });
  it('drops neutral sources as evidence of nothing', () => {
    const r = verdictFromJudgments([j('supports'), j('neutral')]);
    expect(r.verdict).toBe('supported');
    expect(r.supporting).toHaveLength(1);
  });
  it('ranks evidence by judge confidence', () => {
    const r = verdictFromJudgments([j('supports', 0.4), j('supports', 0.9)]);
    expect(r.supporting.map((s) => s.confidence)).toEqual([0.9, 0.4]);
  });
});

describe('validateFact (harness)', () => {
  const fact: FactRef = { subject: 'urn:s', predicate: 'urn:p', object: 'urn:o' };

  it('searches, judges each source, and folds a verdict', async () => {
    const plugins = {
      search: vi.fn(async () => [
        { url: 'a', title: 'A', content: 'agrees' },
        { url: 'b', title: 'B', content: 'disagrees' },
      ]),
      judge: vi.fn(async (_f: FactRef, src: { url: string }) => src.url === 'a'
        ? { stance: 'supports' as const, confidence: 0.9 }
        : { stance: 'contradicts' as const, confidence: 0.7 }),
    };
    const res = await validateFact(fact, plugins);
    expect(res.verdict).toBe('mixed');
    expect(res.evidence).toMatch(/DISAGREE/);
    expect(plugins.judge).toHaveBeenCalledTimes(2);
  });

  it('never throws when search fails — returns unverified', async () => {
    const res = await validateFact(fact, {
      search: async () => { throw new Error('network'); },
      judge: async () => ({ stance: 'supports', confidence: 1 }),
    });
    expect(res.verdict).toBe('unverified');
  });

  it('skips a source it cannot judge rather than failing the whole validation', async () => {
    const res = await validateFact(fact, {
      search: async () => [{ url: 'a', title: 'A', content: 'x' }, { url: 'b', title: 'B', content: 'y' }],
      judge: async (_f, src) => { if (src.url === 'b') throw new Error('judge failed'); return { stance: 'supports', confidence: 0.8 }; },
    });
    expect(res.verdict).toBe('supported');
    expect(res.supporting).toHaveLength(1);
  });
});
