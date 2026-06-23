/**
 * Embedding Model Evaluation — Scoring utilities
 *
 * Evaluation metrics tailored to Reckons.AI's four embedding use cases:
 *   1. Near-duplicate detection (merge suggestions)  → Retrieval precision/recall
 *   2. Semantic search across KB                     → nDCG, MRR
 *   3. Clustering pending triples                    → Adjusted Rand Index, silhouette
 *   4. Cross-KB alignment (entity matching)          → Alignment accuracy, MAP
 *
 * Methodology draws from MTEB (Massive Text Embedding Benchmark) scoring
 * adapted for KB-specific tasks. Each task produces a 0–1 score; the final
 * composite weighs by importance to Reckons.AI workflows.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface SimilarityPair {
  textA: string;
  textB: string;
  expected: 'similar' | 'related' | 'unrelated';
  category: string;
}

export interface RetrievalQuery {
  query: string;
  /** Relevant document IDs, in order of decreasing relevance */
  relevant: string[];
  /** Pool of all document IDs (relevant + irrelevant) */
  corpus: Array<{ id: string; text: string }>;
}

export interface ClusterGolden {
  name: string;
  items: string[];
}

export interface AlignmentGolden {
  /** Entity from KB-A */
  entityA: string;
  /** Expected match in KB-B (null = no match expected) */
  entityB: string | null;
}

// ── 1. Similarity Classification ─────────────────────────────────────────────
// Maps to: merge detection, near-duplicate flagging

export interface SimilarityScore {
  accuracy: number;
  /** Per-category breakdown */
  categoryAccuracy: Record<string, number>;
  /** Threshold calibration: optimal threshold for this model */
  optimalThreshold: number;
  /** Area under the ROC curve for similar vs not-similar */
  auroc: number;
}

/**
 * Score similarity classification: given cosine scores and expected labels,
 * measure how well the model separates similar/related/unrelated pairs.
 */
export function scoreSimilarityClassification(
  pairs: Array<{ pair: SimilarityPair; cosine: number }>,
): SimilarityScore {
  // Per-category accuracy
  const catMap = new Map<string, { total: number; correct: number }>();
  let totalCorrect = 0;

  for (const { pair, cosine } of pairs) {
    let passed: boolean;
    if (pair.expected === 'similar') passed = cosine >= 0.65;
    else if (pair.expected === 'related') passed = cosine >= 0.3 && cosine < 0.85;
    else passed = cosine < 0.45;

    if (passed) totalCorrect++;

    const cat = catMap.get(pair.category) ?? { total: 0, correct: 0 };
    cat.total++;
    if (passed) cat.correct++;
    catMap.set(pair.category, cat);
  }

  const categoryAccuracy: Record<string, number> = {};
  for (const [cat, { total, correct }] of catMap) {
    categoryAccuracy[cat] = total > 0 ? correct / total : 0;
  }

  // Find optimal threshold for binary similar/not-similar classification
  const binaryPairs = pairs.map(({ pair, cosine }) => ({
    cosine,
    isPositive: pair.expected === 'similar',
  }));

  const thresholds = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
  let bestThreshold = 0.65;
  let bestF1 = 0;

  for (const t of thresholds) {
    let tp = 0, fp = 0, fn = 0;
    for (const { cosine, isPositive } of binaryPairs) {
      const predicted = cosine >= t;
      if (predicted && isPositive) tp++;
      else if (predicted && !isPositive) fp++;
      else if (!predicted && isPositive) fn++;
    }
    const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
    const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
    const f1 = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;
    if (f1 > bestF1) {
      bestF1 = f1;
      bestThreshold = t;
    }
  }

  // Simple AUROC approximation (trapezoidal)
  const sorted = [...binaryPairs].sort((a, b) => b.cosine - a.cosine);
  const totalPositive = sorted.filter(p => p.isPositive).length;
  const totalNegative = sorted.length - totalPositive;
  let auroc = 0;
  if (totalPositive > 0 && totalNegative > 0) {
    let tpCount = 0, fpCount = 0;
    let prevTpr = 0, prevFpr = 0;
    for (const p of sorted) {
      if (p.isPositive) tpCount++;
      else fpCount++;
      const tpr = tpCount / totalPositive;
      const fpr = fpCount / totalNegative;
      auroc += (fpr - prevFpr) * (tpr + prevTpr) / 2;
      prevTpr = tpr;
      prevFpr = fpr;
    }
  }

  return {
    accuracy: pairs.length > 0 ? totalCorrect / pairs.length : 0,
    categoryAccuracy,
    optimalThreshold: bestThreshold,
    auroc,
  };
}

// ── 2. Retrieval Quality (nDCG, MRR) ─────────────────────────────────────────
// Maps to: semantic search, BM25 comparison

export interface RetrievalScore {
  /** Normalized Discounted Cumulative Gain at k */
  ndcg: number;
  /** Mean Reciprocal Rank */
  mrr: number;
  /** Precision at k=5 */
  precision5: number;
  /** Recall at k=10 */
  recall10: number;
}

/**
 * Score retrieval quality. Given ranked results, compute nDCG@10, MRR, P@5, R@10.
 *
 * This is the core MTEB retrieval metric adapted for KB search.
 */
export function scoreRetrieval(
  queries: Array<{
    query: RetrievalQuery;
    /** Ranked result IDs from the model (best first) */
    rankedResults: string[];
  }>,
): RetrievalScore {
  let totalNdcg = 0;
  let totalMrr = 0;
  let totalP5 = 0;
  let totalR10 = 0;

  for (const { query, rankedResults } of queries) {
    const relevantSet = new Set(query.relevant);
    const k = 10;

    // nDCG@k
    let dcg = 0;
    for (let i = 0; i < Math.min(rankedResults.length, k); i++) {
      if (relevantSet.has(rankedResults[i])) {
        // Binary relevance: 1 if relevant, 0 otherwise
        dcg += 1 / Math.log2(i + 2);
      }
    }
    let idealDcg = 0;
    for (let i = 0; i < Math.min(relevantSet.size, k); i++) {
      idealDcg += 1 / Math.log2(i + 2);
    }
    totalNdcg += idealDcg > 0 ? dcg / idealDcg : 0;

    // MRR: rank of first relevant result
    const firstRelevantIdx = rankedResults.findIndex(id => relevantSet.has(id));
    totalMrr += firstRelevantIdx >= 0 ? 1 / (firstRelevantIdx + 1) : 0;

    // P@5
    const top5Relevant = rankedResults.slice(0, 5).filter(id => relevantSet.has(id)).length;
    totalP5 += top5Relevant / Math.min(5, rankedResults.length || 1);

    // R@10
    const top10Relevant = rankedResults.slice(0, 10).filter(id => relevantSet.has(id)).length;
    totalR10 += relevantSet.size > 0 ? top10Relevant / relevantSet.size : 0;
  }

  const n = queries.length || 1;
  return {
    ndcg: totalNdcg / n,
    mrr: totalMrr / n,
    precision5: totalP5 / n,
    recall10: totalR10 / n,
  };
}

// ── 3. Clustering Quality ────────────────────────────────────────────────────
// Maps to: grouping pending triples, entity clustering

export interface ClusterScore {
  /** Average intra-cluster cosine similarity */
  intraAvg: number;
  /** Average inter-cluster cosine similarity */
  interAvg: number;
  /** Separation ratio: (intra - inter) / max(intra, 0.01) */
  separationRatio: number;
  /** Silhouette-like score: average of (intra - inter) / max(intra, inter) per item */
  silhouette: number;
  /** V-measure: harmonic mean of homogeneity and completeness */
  vMeasure: number;
}

/**
 * Score clustering quality by comparing predicted clusters against golden groups.
 * Uses cosine-based metrics since that's what Reckons.AI's `cluster()` uses.
 */
export function scoreClustering(
  groups: ClusterGolden[],
  embedFn: (text: string) => Float32Array,
  cosineFn: (a: Float32Array, b: Float32Array) => number,
  threshold: number = 0.85,
): ClusterScore {
  // Embed all items
  const allItems: Array<{ group: number; text: string; vec: Float32Array }> = [];
  for (let gi = 0; gi < groups.length; gi++) {
    for (const item of groups[gi].items) {
      allItems.push({ group: gi, text: item, vec: embedFn(item) });
    }
  }

  if (allItems.length < 2) {
    return { intraAvg: 0, interAvg: 0, separationRatio: 0, silhouette: 0, vMeasure: 0 };
  }

  // Compute intra and inter cluster similarities
  let intraSum = 0, intraCount = 0;
  let interSum = 0, interCount = 0;
  const silhouettes: number[] = [];

  for (let i = 0; i < allItems.length; i++) {
    let sameSum = 0, sameCount = 0;
    let diffSum = 0, diffCount = 0;

    for (let j = 0; j < allItems.length; j++) {
      if (i === j) continue;
      const sim = cosineFn(allItems[i].vec, allItems[j].vec);

      if (allItems[i].group === allItems[j].group) {
        sameSum += sim;
        sameCount++;
        intraSum += sim;
        intraCount++;
      } else {
        diffSum += sim;
        diffCount++;
        interSum += sim;
        interCount++;
      }
    }

    const a = sameCount > 0 ? sameSum / sameCount : 0;
    const b = diffCount > 0 ? diffSum / diffCount : 0;
    const s = Math.max(a, b) > 0 ? (a - b) / Math.max(a, b) : 0;
    silhouettes.push(s);
  }

  const intraAvg = intraCount > 0 ? intraSum / intraCount : 0;
  const interAvg = interCount > 0 ? interSum / interCount : 0;
  const separationRatio = Math.max(intraAvg, 0.01) > 0 ? (intraAvg - interAvg) / Math.max(intraAvg, 0.01) : 0;
  const silhouette = silhouettes.length > 0 ? silhouettes.reduce((a, b) => a + b, 0) / silhouettes.length : 0;

  // V-measure approximation using single-link clustering at the given threshold
  // Run the actual clustering algorithm from embed.ts
  const n = allItems.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a: number, b: number) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[ra] = rb; };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (cosineFn(allItems[i].vec, allItems[j].vec) >= threshold) union(i, j);
    }
  }

  // Predicted clusters
  const predClusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!predClusters.has(r)) predClusters.set(r, []);
    predClusters.get(r)!.push(i);
  }

  // Compute homogeneity and completeness for V-measure
  const predLabels = new Array(n);
  let clustIdx = 0;
  for (const members of predClusters.values()) {
    for (const m of members) predLabels[m] = clustIdx;
    clustIdx++;
  }
  const trueLabels = allItems.map(item => item.group);

  const vMeasure = computeVMeasure(trueLabels, predLabels, groups.length, predClusters.size);

  return { intraAvg, interAvg, separationRatio, silhouette, vMeasure };
}

/** V-measure: harmonic mean of homogeneity and completeness */
function computeVMeasure(
  trueLabels: number[],
  predLabels: number[],
  nTrue: number,
  nPred: number,
): number {
  const n = trueLabels.length;
  if (n === 0 || nTrue <= 1 || nPred <= 1) return 0;

  // Contingency table
  const contingency = new Map<string, number>();
  const trueCount = new Map<number, number>();
  const predCount = new Map<number, number>();

  for (let i = 0; i < n; i++) {
    const key = `${trueLabels[i]},${predLabels[i]}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    trueCount.set(trueLabels[i], (trueCount.get(trueLabels[i]) ?? 0) + 1);
    predCount.set(predLabels[i], (predCount.get(predLabels[i]) ?? 0) + 1);
  }

  // Entropy
  const entropy = (counts: Map<number, number>) => {
    let h = 0;
    for (const c of counts.values()) {
      if (c > 0) {
        const p = c / n;
        h -= p * Math.log2(p);
      }
    }
    return h;
  };

  const hTrue = entropy(trueCount);
  const hPred = entropy(predCount);

  // Conditional entropy H(True|Pred) and H(Pred|True)
  let hTrueGivenPred = 0;
  for (const [, predC] of predCount) {
    for (const [, trueC] of trueCount) {
      // Find intersection count
      // We need to iterate contingency for this pred cluster
    }
  }

  // Simplified: compute conditional entropies directly
  hTrueGivenPred = 0;
  for (const [key, count] of contingency) {
    const predLabel = parseInt(key.split(',')[1]);
    const predTotal = predCount.get(predLabel)!;
    if (count > 0 && predTotal > 0) {
      hTrueGivenPred -= (count / n) * Math.log2(count / predTotal);
    }
  }

  let hPredGivenTrue = 0;
  for (const [key, count] of contingency) {
    const trueLabel = parseInt(key.split(',')[0]);
    const trueTotal = trueCount.get(trueLabel)!;
    if (count > 0 && trueTotal > 0) {
      hPredGivenTrue -= (count / n) * Math.log2(count / trueTotal);
    }
  }

  const homogeneity = hTrue > 0 ? 1 - hTrueGivenPred / hTrue : 1;
  const completeness = hPred > 0 ? 1 - hPredGivenTrue / hPred : 1;

  if (homogeneity + completeness === 0) return 0;
  return 2 * homogeneity * completeness / (homogeneity + completeness);
}

// ── 4. Alignment Accuracy (MAP) ──────────────────────────────────────────────
// Maps to: cross-KB entity matching

export interface AlignmentScore {
  /** Fraction of correct matches at threshold */
  accuracy: number;
  /** Mean Average Precision over ranked candidates */
  map: number;
  /** Recall: fraction of true matches found */
  recall: number;
  /** False positive rate: false matches / total negatives */
  falsePositiveRate: number;
}

/**
 * Score cross-KB alignment quality.
 * Given entity pairs and embeddings, test whether the model correctly
 * identifies matching entities across KBs.
 */
export function scoreAlignment(
  pairs: AlignmentGolden[],
  embedFn: (text: string) => Float32Array,
  cosineFn: (a: Float32Array, b: Float32Array) => number,
  threshold: number = 0.85,
): AlignmentScore {
  // Separate into KB-A entities and KB-B entities
  const kbAEntities = pairs.map(p => p.entityA);
  const kbBEntities = [...new Set(pairs.filter(p => p.entityB).map(p => p.entityB!))];

  if (kbBEntities.length === 0) {
    return { accuracy: 0, map: 0, recall: 0, falsePositiveRate: 0 };
  }

  const kbAVecs = kbAEntities.map(e => embedFn(e));
  const kbBVecs = kbBEntities.map(e => embedFn(e));

  let correct = 0;
  let totalWithMatch = 0;
  let falsePositives = 0;
  let totalNegatives = 0;
  let totalAP = 0;

  for (let ai = 0; ai < pairs.length; ai++) {
    const expectedMatch = pairs[ai].entityB;

    // Rank all KB-B entities by similarity to this KB-A entity
    const scores = kbBEntities.map((_, bi) => ({
      entity: kbBEntities[bi],
      cosine: cosineFn(kbAVecs[ai], kbBVecs[bi]),
    })).sort((a, b) => b.cosine - a.cosine);

    const bestMatch = scores[0].cosine >= threshold ? scores[0].entity : null;

    if (expectedMatch) {
      totalWithMatch++;
      if (bestMatch === expectedMatch) correct++;

      // AP for this query
      const rank = scores.findIndex(s => s.entity === expectedMatch);
      if (rank >= 0 && scores[rank].cosine >= threshold) {
        totalAP += 1 / (rank + 1);
      }
    } else {
      totalNegatives++;
      if (bestMatch !== null) falsePositives++;
    }
  }

  return {
    accuracy: totalWithMatch > 0 ? correct / totalWithMatch : 0,
    map: totalWithMatch > 0 ? totalAP / totalWithMatch : 0,
    recall: totalWithMatch > 0 ? correct / totalWithMatch : 0,
    falsePositiveRate: totalNegatives > 0 ? falsePositives / totalNegatives : 0,
  };
}

// ── Composite Score ──────────────────────────────────────────────────────────

export interface CompositeEmbedScore {
  /** Weighted composite (0-1) */
  overall: number;
  /** Per-task scores */
  similarity: SimilarityScore;
  retrieval: RetrievalScore | null;
  clustering: ClusterScore | null;
  alignment: AlignmentScore | null;
  /** Breakdown of weights used */
  weights: Record<string, number>;
}

/**
 * Combine all task scores into a single composite.
 *
 * Weights reflect importance to Reckons.AI workflows:
 *   - Similarity (merge detection): 30%
 *   - Retrieval (search):           25%
 *   - Clustering (triple grouping):  20%
 *   - Alignment (cross-KB):         25%
 */
export function computeComposite(
  similarity: SimilarityScore,
  retrieval: RetrievalScore | null,
  clustering: ClusterScore | null,
  alignment: AlignmentScore | null,
): CompositeEmbedScore {
  const weights: Record<string, number> = {
    similarity: 0.30,
    retrieval: 0.25,
    clustering: 0.20,
    alignment: 0.25,
  };

  // Normalize each task to 0-1
  const simScore = (similarity.accuracy + similarity.auroc) / 2;
  const retScore = retrieval ? (retrieval.ndcg + retrieval.mrr) / 2 : 0;
  const clustScore = clustering
    ? Math.max(0, (clustering.silhouette + clustering.vMeasure) / 2)
    : 0;
  const alignScore = alignment ? (alignment.accuracy + alignment.map) / 2 : 0;

  // If a task wasn't run, redistribute its weight
  let totalWeight = 0;
  const scores: Array<{ weight: number; score: number }> = [];

  scores.push({ weight: weights.similarity, score: simScore });
  totalWeight += weights.similarity;

  if (retrieval) {
    scores.push({ weight: weights.retrieval, score: retScore });
    totalWeight += weights.retrieval;
  }
  if (clustering) {
    scores.push({ weight: weights.clustering, score: clustScore });
    totalWeight += weights.clustering;
  }
  if (alignment) {
    scores.push({ weight: weights.alignment, score: alignScore });
    totalWeight += weights.alignment;
  }

  const overall = totalWeight > 0
    ? scores.reduce((sum, s) => sum + (s.weight / totalWeight) * s.score, 0)
    : 0;

  return { overall, similarity, retrieval, clustering, alignment, weights };
}

// ── Formatting ───────────────────────────────────────────────────────────────

export function formatCompositeScore(score: CompositeEmbedScore): string {
  const lines: string[] = [];

  lines.push(`  Overall Composite: ${pct(score.overall)}`);
  lines.push('');

  lines.push(`  Similarity (merge detection):`);
  lines.push(`    Accuracy: ${pct(score.similarity.accuracy)}  AUROC: ${pct(score.similarity.auroc)}  Optimal threshold: ${score.similarity.optimalThreshold.toFixed(2)}`);
  for (const [cat, acc] of Object.entries(score.similarity.categoryAccuracy)) {
    lines.push(`      ${cat}: ${pct(acc)}`);
  }

  if (score.retrieval) {
    lines.push(`  Retrieval (search):`);
    lines.push(`    nDCG@10: ${pct(score.retrieval.ndcg)}  MRR: ${pct(score.retrieval.mrr)}  P@5: ${pct(score.retrieval.precision5)}  R@10: ${pct(score.retrieval.recall10)}`);
  }

  if (score.clustering) {
    lines.push(`  Clustering (triple grouping):`);
    lines.push(`    Silhouette: ${score.clustering.silhouette.toFixed(3)}  V-measure: ${pct(score.clustering.vMeasure)}  Separation: ${score.clustering.separationRatio.toFixed(3)}`);
  }

  if (score.alignment) {
    lines.push(`  Alignment (cross-KB):`);
    lines.push(`    Accuracy: ${pct(score.alignment.accuracy)}  MAP: ${pct(score.alignment.map)}  Recall: ${pct(score.alignment.recall)}  FPR: ${pct(score.alignment.falsePositiveRate)}`);
  }

  return lines.join('\n');
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}
