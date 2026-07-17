/**
 * The merge band — ONE confidence rule for entity merge, fact->entity linking, and
 * predicate-sameness (Matt, 2026-07-15).
 *
 * Decided in the graph and mirrored here as the executable copy:
 *   static/reckons-roadmap.ttl
 *     kb:auto-merge        kpred:auto-merge-threshold "0.9" ; kpred:suggest-merge-floor "0.5"
 *     kb:link-confidence   (moved onto this same band, superseding the 2026-07-13 ~0.80)
 *     kb:browser-fact-finding (F82), kb:predicate-manager  — all reference this one band
 *
 * The graph is the source of truth; these constants are the code that acts on it. The align
 * gate does not (yet) generate them, so if the graph's thresholds change, change them here too.
 *
 * WHY THIS SHAPE. The band is deliberately conservative on the destructive end. Nothing merges
 * or links WITHOUT REVIEW unless it is >=90% the same (after entity normalization, F22). The
 * 50-90% band is the answer to the silent-destruction risk that kb:predicate-manager had to be
 * cured of: it does not act, it SUGGESTS — a reviewable proposal, never a silent write. Below
 * 50% we propose nothing at all, because a forced link is worse than an orphan (kb:link-confidence):
 * an invented edge looks like knowledge and is not.
 *
 * Similarity here is SEMANTIC, not lexical (embeddings, kb:embedding-model) — a synonym is a
 * likely connection. This module does not compute similarity; it classifies a score someone else
 * measured, so it stays pure and deterministic. The predicate is the main clue to a valid link
 * (kb:predicate-economy), so callers should weight predicate agreement into the score they pass.
 */

/** At or above this, the two are the same thing: auto-merge (still reviewable, never silent-final). */
export const MERGE_AUTO_THRESHOLD = 0.9;
/** At or above this (but below auto), they are worth SUGGESTING a merge for. Below it: nothing. */
export const MERGE_SUGGEST_FLOOR = 0.5;

/**
 * What to do with a candidate pair at a given similarity:
 *   'auto'    — treat as the same; create the merge (as a reviewable action, per F80.1)
 *   'suggest' — surface it for human review; do NOT act
 *   'none'    — propose nothing; a forced link is worse than an orphan
 */
export type MergeVerdict = 'auto' | 'suggest' | 'none';

/**
 * Classify a similarity score into the decided band. A NaN or out-of-range score yields 'none' —
 * the safe direction is always "do nothing", never "merge on a number we do not trust".
 */
export function classifyMerge(similarity: number): MergeVerdict {
  if (!Number.isFinite(similarity)) return 'none';
  if (similarity >= MERGE_AUTO_THRESHOLD) return 'auto';
  if (similarity >= MERGE_SUGGEST_FLOOR) return 'suggest';
  return 'none';
}

/** Convenience: does this score clear the auto-merge bar? */
export function isAutoMerge(similarity: number): boolean {
  return classifyMerge(similarity) === 'auto';
}

/** Convenience: is this score in the suggest band (surface for review, do not act)? */
export function isSuggestMerge(similarity: number): boolean {
  return classifyMerge(similarity) === 'suggest';
}

/** Human-readable label for a verdict, for review UIs and logs. */
export const MERGE_VERDICT_LABEL: Record<MergeVerdict, string> = {
  auto: `auto-merge (>=${MERGE_AUTO_THRESHOLD}) — the same thing; merged as a reviewable action`,
  suggest: `suggested (${MERGE_SUGGEST_FLOOR}-${MERGE_AUTO_THRESHOLD}) — surfaced for review, not acted on`,
  none: `no action (<${MERGE_SUGGEST_FLOOR}) — a forced link is worse than an orphan`,
};
