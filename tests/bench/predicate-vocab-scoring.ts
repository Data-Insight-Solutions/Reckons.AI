/**
 * Predicate Vocabulary Scoring — does an embedding model separate "another word for the same
 * relation" from "a different relation that looks similar"?
 *
 * This scores the decision `src/lib/rdf/normalize-entities.ts` actually makes at write time:
 * rewrite an incoming predicate IRI to an existing one when cosine >= PREDICATE_MATCH_THRESHOLD.
 *
 * THE TWO ERRORS ARE NOT SYMMETRIC, and every metric here is shaped by that.
 *
 *   A MISSED MERGE leaves a duplicate predicate in the graph. The fact still reaches the review
 *   queue, a human still sees it, and predicate-manager can merge it later. Recoverable, visible.
 *
 *   A FALSE MERGE rewrites a fact into a DIFFERENT fact before any human sees it. `has-predator`
 *   becomes `has-prey` and the food chain reverses, silently, inside the normalization step.
 *   Unrecoverable, invisible.
 *
 * So the headline number is not accuracy or F1 — averaging the two would let a model buy recall
 * with corruption. It is `safeThreshold`: the lowest threshold at which ZERO must-not-merge pairs
 * merge, and the recall a model can actually reach while staying there. A model with no such
 * threshold (its worst false pair outranks its best true pair) is unusable at ANY setting, and
 * saying so is the point.
 *
 * Pure functions only — no model loading, no network — so the whole file is unit-testable and the
 * bench runner supplies the vectors.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface PredicatePair {
  a: string;
  b: string;
  why: string;
  /** shouldMerge entries carry provenance: 'observed' in a real model run, or 'constructed'. */
  source?: 'observed' | 'constructed';
  /** mustNotMerge entries carry the cost of getting them wrong. */
  severity?: 'high' | 'medium' | 'low';
}

export interface PredicatePairFixture {
  shouldMerge: PredicatePair[];
  mustNotMerge: PredicatePair[];
}

/** One pair with the cosine a model gave it. */
export interface ScoredPair extends PredicatePair {
  cosine: number;
}

export interface ThresholdScore {
  threshold: number;
  /** Fraction of shouldMerge pairs at or above the threshold (0-1). */
  mergeRecall: number;
  /** Fraction of mustNotMerge pairs at or above the threshold (0-1). The expensive error. */
  falseMergeRate: number;
  /** mustNotMerge pairs that would be merged at this threshold, worst first. */
  falseMerges: ScoredPair[];
  /** shouldMerge pairs that would be missed at this threshold. */
  missedMerges: ScoredPair[];
}

export interface PredicateVocabScore {
  model: string;
  shouldMerge: ScoredPair[];
  mustNotMerge: ScoredPair[];
  /** Score at the threshold production actually ships. */
  atProduction: ThresholdScore;
  /**
   * Lowest threshold (on a 0.01 grid) with zero false merges, or null when no threshold separates
   * the classes — i.e. the model's worst false pair scores at or above its best true pair.
   */
  safeThreshold: number | null;
  /** mergeRecall at safeThreshold; 0 when there is none. */
  recallAtSafeThreshold: number;
  /**
   * min(shouldMerge cosine) - max(mustNotMerge cosine). Positive means a clean gap exists and the
   * only question is where to put the line. Negative means the classes overlap and NO single
   * threshold can separate them — the honest reading is that cosine alone cannot make this call.
   */
  separation: number;
  /** Sweep across the plausible band, for plotting and for choosing a new constant. */
  sweep: ThresholdScore[];
}

// ── Threshold scoring ────────────────────────────────────────────────────────

export function scoreAtThreshold(
  shouldMerge: ScoredPair[],
  mustNotMerge: ScoredPair[],
  threshold: number,
): ThresholdScore {
  const merged = shouldMerge.filter((p) => p.cosine >= threshold);
  const falseMerges = mustNotMerge
    .filter((p) => p.cosine >= threshold)
    .sort((x, y) => y.cosine - x.cosine);
  const missedMerges = shouldMerge
    .filter((p) => p.cosine < threshold)
    .sort((x, y) => x.cosine - y.cosine);

  return {
    threshold,
    mergeRecall: shouldMerge.length > 0 ? merged.length / shouldMerge.length : 0,
    falseMergeRate: mustNotMerge.length > 0 ? falseMerges.length / mustNotMerge.length : 0,
    falseMerges,
    missedMerges,
  };
}

/**
 * Thresholds on a 0.01 grid across [min, max]. A grid rather than the observed cosines themselves
 * because the output is meant to be READ and then written into the source as a constant, and
 * `0.91` is a constant a person can defend where `0.9073` is a number fitted to twelve pairs.
 */
export function sweepThresholds(
  shouldMerge: ScoredPair[],
  mustNotMerge: ScoredPair[],
  min = 0.5,
  max = 0.99,
): ThresholdScore[] {
  const out: ThresholdScore[] = [];
  for (let t = Math.round(min * 100); t <= Math.round(max * 100); t++) {
    out.push(scoreAtThreshold(shouldMerge, mustNotMerge, t / 100));
  }
  return out;
}

/**
 * The lowest threshold on the grid with zero false merges.
 *
 * Lowest rather than highest because every step above it trades away recall for nothing: once no
 * bad pair merges, raising the line only loses good ones. Returns null when no grid point is
 * clean, which is a real answer and not a failure — it says the classes overlap.
 */
export function findSafeThreshold(sweep: ThresholdScore[]): number | null {
  const clean = sweep.filter((s) => s.falseMergeRate === 0);
  if (clean.length === 0) return null;
  return clean.reduce((lo, s) => (s.threshold < lo.threshold ? s : lo)).threshold;
}

export function scorePredicateVocab(
  model: string,
  shouldMerge: ScoredPair[],
  mustNotMerge: ScoredPair[],
  productionThreshold: number,
): PredicateVocabScore {
  const sweep = sweepThresholds(shouldMerge, mustNotMerge);
  const safeThreshold = findSafeThreshold(sweep);
  const atSafe = safeThreshold === null
    ? null
    : scoreAtThreshold(shouldMerge, mustNotMerge, safeThreshold);

  const minShould = shouldMerge.length > 0 ? Math.min(...shouldMerge.map((p) => p.cosine)) : 0;
  const maxMustNot = mustNotMerge.length > 0 ? Math.max(...mustNotMerge.map((p) => p.cosine)) : 0;

  return {
    model,
    shouldMerge: [...shouldMerge].sort((x, y) => x.cosine - y.cosine),
    mustNotMerge: [...mustNotMerge].sort((x, y) => y.cosine - x.cosine),
    atProduction: scoreAtThreshold(shouldMerge, mustNotMerge, productionThreshold),
    safeThreshold,
    recallAtSafeThreshold: atSafe ? atSafe.mergeRecall : 0,
    separation: minShould - maxMustNot,
    sweep,
  };
}

// ── Reporting ────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export function formatPredicateVocabReport(s: PredicateVocabScore, productionThreshold: number): string {
  const L: string[] = [];
  L.push(`\n${'═'.repeat(78)}`);
  L.push(`  PREDICATE VOCABULARY — ${s.model}`);
  L.push(`${'═'.repeat(78)}`);

  L.push(`\n── AT THE SHIPPED THRESHOLD (${productionThreshold}) ──`);
  L.push(`  Merge recall:     ${pct(s.atProduction.mergeRecall)}  (${s.shouldMerge.length - s.atProduction.missedMerges.length}/${s.shouldMerge.length} synonym pairs caught)`);
  L.push(`  FALSE merge rate: ${pct(s.atProduction.falseMergeRate)}  (${s.atProduction.falseMerges.length}/${s.mustNotMerge.length} distinct relations wrongly collapsed)`);

  if (s.atProduction.falseMerges.length > 0) {
    L.push(`\n  ⚠ THESE WOULD BE SILENTLY REWRITTEN IN A USER'S GRAPH:`);
    for (const f of s.atProduction.falseMerges) {
      L.push(`      ${f.cosine.toFixed(4)}  ${f.a}  →  ${f.b}   [${f.severity ?? 'unrated'}]`);
      L.push(`              ${f.why}`);
    }
  } else {
    L.push(`\n  ✓ No false merges at the shipped threshold.`);
  }

  if (s.atProduction.missedMerges.length > 0) {
    L.push(`\n  Missed synonyms (recoverable — the fact still reaches review):`);
    for (const m of s.atProduction.missedMerges) {
      L.push(`      ${m.cosine.toFixed(4)}  ${m.a}  ≠  ${m.b}${m.source === 'observed' ? '   [OBSERVED IN A REAL RUN]' : ''}`);
    }
  }

  // The distinct pairs that scored HIGHEST are where the ceiling comes from: they are what stops
  // the threshold being lowered to catch the synonyms below them. Printing only the worst one hides
  // that, so show the crowded top of the distribution.
  L.push(`\n── CLOSEST DISTINCT RELATIONS (these set the floor under the threshold) ──`);
  for (const m of s.mustNotMerge.slice(0, 5)) {
    L.push(`      ${m.cosine.toFixed(4)}  ${m.a}  ≠  ${m.b}   [${m.severity ?? 'unrated'}]`);
  }

  L.push(`\n── SEPARABILITY ──`);
  L.push(`  Worst synonym pair:   ${s.shouldMerge[0]?.cosine.toFixed(4) ?? 'n/a'}  (${s.shouldMerge[0]?.a} / ${s.shouldMerge[0]?.b})`);
  L.push(`  Worst distinct pair:  ${s.mustNotMerge[0]?.cosine.toFixed(4) ?? 'n/a'}  (${s.mustNotMerge[0]?.a} / ${s.mustNotMerge[0]?.b})`);
  L.push(`  Separation:           ${s.separation >= 0 ? '+' : ''}${s.separation.toFixed(4)}`);

  if (s.separation < 0) {
    L.push(`  ⚠ NEGATIVE — the classes OVERLAP. No single cosine threshold can separate them for`);
    L.push(`    this model. Raising the constant trades false merges for missed merges and never`);
    L.push(`    removes both. Cosine alone cannot make this call.`);
  }

  L.push(`\n── SAFE OPERATING POINT ──`);
  if (s.safeThreshold === null) {
    L.push(`  NONE. Every threshold that catches any synonym also collapses a distinct relation.`);
  } else {
    L.push(`  Lowest zero-false-merge threshold: ${s.safeThreshold.toFixed(2)}`);
    L.push(`  Merge recall there:                ${pct(s.recallAtSafeThreshold)}`);
    if (s.safeThreshold > productionThreshold) {
      L.push(`  → The shipped ${productionThreshold} is BELOW this. It is merging things it should not.`);
    } else {
      L.push(`  → The shipped ${productionThreshold} is at or above this, so it is safe but costs recall.`);
    }
  }

  L.push(`${'═'.repeat(78)}\n`);
  return L.join('\n');
}
