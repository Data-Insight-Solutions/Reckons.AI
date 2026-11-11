/**
 * RUN SAMPLER — first draft of F89.4.5 (kb:review-sample-gate). NO WIRING.
 *
 * A run writes ALL of its rows to its own file in the workspace; only a SAMPLE enters the review
 * queue. This is that sampler: a pure, deterministic pick of at most `size` rows from a run's rows.
 *
 * The rule (F89.4.5):
 *   - take ONE row per distinct predicate before it repeats any predicate, and
 *   - seed the pick by the run's id, so the SAME run always yields the SAME (ordered) sample.
 *
 * The seed is a hash of the run id (FNV-1a) driving a deterministic Fisher-Yates order of the
 * predicates — never Math.random. "Same rows + same run id -> same sample" follows from that order
 * being fixed; a different run id gives a different order. Within a predicate the rows are taken in
 * their input order (stable), one per round, and only after every predicate has been taken once —
 * that is the one-per-predicate rule.
 *
 * Pure and side-effect free: it reads `rows`, allocates fresh arrays, and returns the SAME row
 * objects (so the caller can act on them). It never mutates the input.
 *
 * OPEN FOR THE OVERSEER (not fixed by the brief): the seed changes the ORDER and which predicates
 * fill a short sample, but within a predicate it always takes the FIRST rows in input order. If we
 * want different runs to sample different rows of the SAME predicate, the seed must also pick a
 * per-predicate starting offset — one small change, say so.
 */

export type Row = { readonly predicate: string };

const FNV_OFFSET = 2166136261 >>> 0;
const FNV_PRIME = 16777619;

/** run id -> a stable unsigned 32-bit seed (FNV-1a). Same id -> same seed. */
function seedFromRunId(runId: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < runId.length; i++) {
    h ^= runId.charCodeAt(i); // full 16-bit unit: masking to 8 bits made ids that differ only past Latin-1 collide
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** A tiny deterministic PRNG (mulberry32) from a 32-bit seed. No Math.random anywhere. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** In-place Fisher-Yates driven by `rng`. Returns the same array, reordered deterministically. */
function seededShuffle<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Deterministic sample of a run's rows, seeded by the run id.
 *
 * @param rows   the run's rows; each carries at least a `predicate` string.
 * @param runId  the run's id; hashed to seed the pick (same id -> same sample).
 * @param size   at most this many rows (default 10); never more than `rows` has.
 * @returns up to `size` rows, in a stable order, one per predicate before any is repeated.
 */
export function sampleRun<T extends Row>(rows: readonly T[], runId: string, size = 10): T[] {
  const limit = Math.max(0, Math.floor(size));
  if (limit === 0 || rows.length === 0) return [];

  // Group rows by predicate, keeping input order inside each group (the stable within-group order).
  const byPredicate = new Map<string, T[]>();
  for (const row of rows) {
    const group = byPredicate.get(row.predicate);
    if (group) group.push(row);
    else byPredicate.set(row.predicate, [row]);
  }

  // Seeded visit order of the predicates. Same (rows, runId) -> same order -> same sample.
  const order = seededShuffle([...byPredicate.keys()], makeRng(seedFromRunId(runId)));

  // Round-robin: round k takes the k-th row of each predicate, so no predicate is repeated before
  // every predicate has been taken once. Stop at `limit`, or when a round adds nothing (every group
  // is shorter than k, i.e. no rows are left to take).
  const sample: T[] = [];
  let k = 0;
  let added = true;
  while (added && sample.length < limit) {
    added = false;
    for (const p of order) {
      if (sample.length >= limit) break;
      const group = byPredicate.get(p);
      const row = group ? group[k] : undefined;
      if (row === undefined) continue;
      sample.push(row);
      added = true;
    }
    k++;
  }
  return sample;
}
