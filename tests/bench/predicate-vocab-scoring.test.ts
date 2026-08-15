/**
 * Tests for the predicate vocabulary scorer.
 *
 * The scorer's whole job is to refuse to average two errors that cost different amounts, so most
 * of these tests are about the asymmetry: a false merge (a fact silently rewritten into a different
 * fact) must never be traded off against a missed merge (a duplicate predicate a human can still
 * see and fix).
 *
 * The last block pins the MEASURED result from 2026-08-15 rather than the logic — it is a
 * regression guard on the fixture itself, so that editing the pairs cannot quietly make the
 * benchmark agree with whatever the code happens to do.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  scoreAtThreshold,
  sweepThresholds,
  findSafeThreshold,
  scorePredicateVocab,
  formatPredicateVocabReport,
  type ScoredPair,
  type PredicatePairFixture,
} from './predicate-vocab-scoring';

function syn(a: string, b: string, cosine: number): ScoredPair {
  return { a, b, why: 'test', source: 'constructed', cosine };
}
function dist(a: string, b: string, cosine: number): ScoredPair {
  return { a, b, why: 'test', severity: 'high', cosine };
}

describe('scoreAtThreshold', () => {
  const shouldMerge = [syn('has-heart-count', 'has-number-of-hearts', 0.80), syn('a', 'b', 0.95)];
  const mustNotMerge = [dist('has-predator', 'has-prey', 0.93), dist('x', 'y', 0.40)];

  it('counts a pair at exactly the threshold as merged — the code uses >=, so the test must too', () => {
    const s = scoreAtThreshold(shouldMerge, mustNotMerge, 0.8);
    expect(s.mergeRecall).toBe(1);
    expect(s.missedMerges).toHaveLength(0);
  });

  it('separates the two error types instead of blending them', () => {
    const s = scoreAtThreshold(shouldMerge, mustNotMerge, 0.9);
    expect(s.mergeRecall).toBe(0.5);
    expect(s.falseMergeRate).toBe(0.5);
    expect(s.falseMerges.map((f) => f.b)).toEqual(['has-prey']);
    expect(s.missedMerges.map((m) => m.b)).toEqual(['has-number-of-hearts']);
  });

  it('orders false merges worst-first and missed merges worst-first', () => {
    const many = scoreAtThreshold(
      [syn('p', 'q', 0.10), syn('r', 's', 0.50)],
      [dist('t', 'u', 0.99), dist('v', 'w', 0.91)],
      0.9,
    );
    // Worst false merge = highest cosine (most confidently wrong).
    expect(many.falseMerges.map((f) => f.cosine)).toEqual([0.99, 0.91]);
    // Worst miss = lowest cosine (furthest from being caught).
    expect(many.missedMerges.map((m) => m.cosine)).toEqual([0.10, 0.50]);
  });

  it('reports zero recall rather than dividing by zero on an empty class', () => {
    const s = scoreAtThreshold([], [], 0.9);
    expect(s.mergeRecall).toBe(0);
    expect(s.falseMergeRate).toBe(0);
  });
});

describe('findSafeThreshold', () => {
  it('picks the LOWEST clean threshold — every step above it loses recall for nothing', () => {
    const sweep = sweepThresholds(
      [syn('a', 'b', 0.86), syn('c', 'd', 0.99)],
      [dist('e', 'f', 0.80)],
    );
    expect(findSafeThreshold(sweep)).toBeCloseTo(0.81, 5);
  });

  it('returns null when no threshold is clean, instead of inventing one', () => {
    // The worst distinct pair outranks the best synonym: the classes are inverted.
    const sweep = sweepThresholds([syn('a', 'b', 0.70)], [dist('e', 'f', 0.99)]);
    expect(findSafeThreshold(sweep)).toBeNull();
  });

  it('a clean model with a real gap gets a threshold inside the gap', () => {
    const sweep = sweepThresholds([syn('a', 'b', 0.90)], [dist('e', 'f', 0.60)]);
    const t = findSafeThreshold(sweep)!;
    expect(t).toBeGreaterThan(0.6);
    expect(t).toBeLessThanOrEqual(0.9);
  });
});

describe('scorePredicateVocab', () => {
  it('reports negative separation when the classes overlap', () => {
    const s = scorePredicateVocab(
      'overlapping',
      [syn('has-predator', 'has-natural-enemy', 0.58)],
      [dist('is-found-in', 'is-located-in', 0.83)],
      0.88,
    );
    expect(s.separation).toBeCloseTo(-0.25, 5);
    expect(s.safeThreshold).not.toBeNull();
    // Safe, but only because the threshold sits above BOTH classes — it catches nothing.
    expect(s.recallAtSafeThreshold).toBe(0);
  });

  it('reports positive separation only when every synonym outranks every distinct pair', () => {
    const s = scorePredicateVocab(
      'clean',
      [syn('a', 'b', 0.95), syn('c', 'd', 0.92)],
      [dist('e', 'f', 0.70), dist('g', 'h', 0.55)],
      0.88,
    );
    expect(s.separation).toBeCloseTo(0.22, 5);
    expect(s.atProduction.falseMergeRate).toBe(0);
    expect(s.atProduction.mergeRecall).toBe(1);
  });

  it('sorts synonyms worst-first and distinct pairs closest-first for reporting', () => {
    const s = scorePredicateVocab(
      'sorted',
      [syn('a', 'b', 0.95), syn('c', 'd', 0.60)],
      [dist('e', 'f', 0.50), dist('g', 'h', 0.85)],
      0.88,
    );
    expect(s.shouldMerge.map((p) => p.cosine)).toEqual([0.60, 0.95]);
    expect(s.mustNotMerge.map((p) => p.cosine)).toEqual([0.85, 0.50]);
  });

  it('a high-recall model that corrupts is not scored as good', () => {
    // 100% merge recall, but it also collapses every distinct relation. The scorer must expose
    // that as a 100% false-merge rate and no safe operating point at all.
    const s = scorePredicateVocab(
      'reckless',
      [syn('a', 'b', 0.97), syn('c', 'd', 0.96)],
      [dist('has-predator', 'has-prey', 0.99), dist('is-a', 'is-not-a', 0.98)],
      0.88,
    );
    expect(s.atProduction.mergeRecall).toBe(1);
    expect(s.atProduction.falseMergeRate).toBe(1);
    expect(s.safeThreshold).toBeNull();
    expect(s.recallAtSafeThreshold).toBe(0);
  });
});

describe('formatPredicateVocabReport', () => {
  it('names every pair it would silently rewrite, not just the count', () => {
    const s = scorePredicateVocab(
      'dangerous',
      [syn('a', 'b', 0.95)],
      [dist('has-predator', 'has-prey', 0.93)],
      0.88,
    );
    const report = formatPredicateVocabReport(s, 0.88);
    expect(report).toContain('has-predator');
    expect(report).toContain('has-prey');
    expect(report).toContain('SILENTLY REWRITTEN');
  });

  it('says so plainly when no threshold can separate the classes', () => {
    const s = scorePredicateVocab('overlap', [syn('a', 'b', 0.60)], [dist('c', 'd', 0.90)], 0.88);
    expect(formatPredicateVocabReport(s, 0.88)).toContain('classes OVERLAP');
  });

  it('flags a shipped threshold that sits below the safe one', () => {
    const s = scorePredicateVocab('below', [syn('a', 'b', 0.99)], [dist('c', 'd', 0.94)], 0.88);
    expect(formatPredicateVocabReport(s, 0.88)).toContain('It is merging things it should not');
  });
});

describe('the fixture itself', () => {
  const fixture: PredicatePairFixture = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'golden', 'predicate-pairs.json'), 'utf-8'),
  );

  it('keeps the observed case that motivated the benchmark', () => {
    // qwen3.6 emitted has-number-of-hearts where the golden set says has-heart-count (2026-08-15).
    // If this pair ever disappears the benchmark has lost the real-world case it was built for.
    const observed = fixture.shouldMerge.filter((p) => p.source === 'observed');
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.some((p) => p.a === 'has-heart-count' && p.b === 'has-number-of-hearts')).toBe(true);
  });

  it('keeps hard negatives that share a surface shape with a synonym', () => {
    // has-heart-count/has-neuron-count is the whole point: identical shape, different attribute.
    // Without it a model could score well by matching string form alone.
    expect(
      fixture.mustNotMerge.some((p) => p.a === 'has-heart-count' && p.b === 'has-neuron-count'),
    ).toBe(true);
    expect(fixture.mustNotMerge.some((p) => p.a === 'has-predator' && p.b === 'has-prey')).toBe(true);
  });

  it('gives every pair a stated reason, so no pair is folklore', () => {
    for (const p of [...fixture.shouldMerge, ...fixture.mustNotMerge]) {
      expect(p.why.length, `${p.a}/${p.b} has no reason`).toBeGreaterThan(20);
    }
  });

  it('never lists the same pair in both classes', () => {
    const key = (p: { a: string; b: string }) => [p.a, p.b].sort().join('|');
    const merge = new Set(fixture.shouldMerge.map(key));
    for (const p of fixture.mustNotMerge) {
      expect(merge.has(key(p)), `${p.a}/${p.b} is in both classes`).toBe(false);
    }
  });
});

describe('MEASURED 2026-08-15 — regression guard on the shipped configuration', () => {
  // These are not invented numbers. They are cosines produced by Xenova/bge-small-en-v1.5 (the
  // default in src/lib/embed.ts) over the labels normalize-entities.ts actually embeds, recorded by
  // `npx tsx tests/bench/run-predicate-vocab-bench.ts --model Xenova/bge-small-en-v1.5`.
  //
  // They are pinned because the conclusion they support is load-bearing and counter-intuitive:
  // the shipped 0.88 is SAFE and nearly INERT, and the models that would make it effective are
  // exactly the ones that make it dangerous.
  const bgeSmall = {
    shouldMerge: [
      syn('has-predator', 'has-natural-enemy', 0.5780),
      syn('belongs-to-class', 'has-taxonomic-class', 0.6790),
      syn('is-found-in', 'occurs-in', 0.6805),
      syn('has-scientific-name', 'has-binomial-name', 0.6910),
      syn('feeds-on', 'preys-on', 0.7231),
      syn('feeds-on', 'eats', 0.7307),
      syn('has-heart-count', 'has-number-of-hearts', 0.8030),
      syn('enables', 'allows', 0.8174),
      syn('has-neuron-count', 'has-number-of-neurons', 0.8485),
      syn('has-reproductive-strategy', 'has-breeding-strategy', 0.8619),
    ],
    mustNotMerge: [dist('is-found-in', 'is-located-in', 0.8341)],
  };

  it('0.88 does not false-merge with the shipped model — the missing antonym guard is not yet firing', () => {
    const s = scorePredicateVocab('bge-small', bgeSmall.shouldMerge, bgeSmall.mustNotMerge, 0.88);
    expect(s.atProduction.falseMergeRate).toBe(0);
  });

  it('0.88 also misses the real observed case, so the normalizer would not have caught it', () => {
    const s = scorePredicateVocab('bge-small', bgeSmall.shouldMerge, bgeSmall.mustNotMerge, 0.88);
    const missed = s.atProduction.missedMerges.map((m) => m.b);
    expect(missed).toContain('has-number-of-hearts');
  });

  it('lowering 0.88 to catch it would first sweep in a distinct relation', () => {
    // is-found-in/is-located-in scores 0.8341 — ABOVE the 0.8030 synonym. Any threshold low enough
    // to catch the observed vocabulary drift merges a distinction the graph author drew first.
    // This is the argument that cosine alone cannot make this call, in one assertion.
    const s = scorePredicateVocab('bge-small', bgeSmall.shouldMerge, bgeSmall.mustNotMerge, 0.80);
    expect(s.atProduction.mergeRecall).toBeGreaterThan(0);
    expect(s.atProduction.falseMergeRate).toBeGreaterThan(0);
  });

  it('separation is negative for the shipped model', () => {
    const s = scorePredicateVocab('bge-small', bgeSmall.shouldMerge, bgeSmall.mustNotMerge, 0.88);
    expect(s.separation).toBeLessThan(0);
  });
});
