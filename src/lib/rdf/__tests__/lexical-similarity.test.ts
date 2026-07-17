/**
 * Lexical similarity — the free, deterministic suggest-tier similarity.
 * Honest about its weakness: shared WORDS, not shared meaning (synonyms score 0), which is why it
 * feeds the reviewed suggest tier, never the auto tier.
 */
import { describe, it, expect } from 'vitest';
import { tokenize, jaccard, lexicalFactSimilarity } from '../lexical-similarity';
import type { Statement } from '../types';

function st(s: string, o: string): Statement {
  return {
    id: `${s}-${o}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: 'urn:kbase:predicate/note' },
    o: { kind: 'literal', value: o },
    g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x',
    confidence: 1,
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  } as Statement;
}

describe('tokenize', () => {
  it('lowercases, splits, drops stopwords and 1-char tokens', () => {
    expect([...tokenize('The quick a X brown-fox!')].sort()).toEqual(['brown', 'fox', 'quick']);
  });
});

describe('jaccard', () => {
  it('identical sets = 1, disjoint = 0', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['a', 'b']))).toBe(1);
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });
  it('half overlap', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
  it('empty vs empty is 0 — no evidence, not identity', () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
  });
});

const C = 'urn:kbase:concept/';

describe('lexicalFactSimilarity', () => {
  it('near-identical phrasing (same subject) scores high', () => {
    const sim = lexicalFactSimilarity(st(`${C}release`, 'ships on Friday'), st(`${C}release`, 'ships Friday'));
    expect(sim).toBeGreaterThanOrEqual(0.5);
  });
  it('unrelated facts score 0', () => {
    expect(lexicalFactSimilarity(st(`${C}paint`, 'blue paint'), st(`${C}revenue`, 'quarterly revenue'))).toBe(0);
  });
  it('SAME subject but different object is NOT a duplicate (min of the two)', () => {
    // The bug dogfooding caught: identical subject must not inflate a different-object pair.
    const sim = lexicalFactSimilarity(st(`${C}feature`, 'status is planned'), st(`${C}feature`, 'status is functional'));
    expect(sim).toBeLessThan(0.5);
  });
  it('is symmetric', () => {
    const a = st(`${C}a`, 'alpha beta gamma');
    const b = st(`${C}b`, 'beta gamma delta');
    expect(lexicalFactSimilarity(a, b)).toBe(lexicalFactSimilarity(b, a));
  });
  it('honest weakness: a synonym pair scores 0 (words, not meaning)', () => {
    // This is WHY it only feeds the reviewed suggest tier.
    expect(lexicalFactSimilarity(st(`${C}vehicle`, 'car'), st(`${C}vehicle`, 'automobile'))).toBe(0);
  });
});
