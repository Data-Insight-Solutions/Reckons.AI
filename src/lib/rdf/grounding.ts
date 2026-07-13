/**
 * Passage grounding (kb:passage-grounding).
 *
 * Every extracted triple carries an `excerpt` — the "verbatim source sentence the triple
 * was derived from". The extraction prompt instructs the model: *"Copy it exactly — do
 * not paraphrase."*
 *
 * THAT INSTRUCTION WAS NEVER CHECKED. Nothing in the pipeline verified that the excerpt
 * actually occurred in the source text, so a model that paraphrased — or invented — a
 * quote had it stored and rendered to the user as provenance. For an app whose entire
 * pitch is "knowledge graph · provenance · trust", a FABRICATED CITATION is the worst
 * failure it can have: the user checks the receipt, the receipt looks right, and it is a
 * forgery.
 *
 * Small models paraphrase constantly. This is not a hypothetical.
 *
 * So: verify, and when the excerpt cannot be found in the source, DROP IT. A missing
 * citation is honest. A fabricated one is not — and showing nothing is strictly better
 * than showing a quote the source never contained.
 */

/**
 * Normalize text for comparison. We are checking whether the model QUOTED the source,
 * not whether it produced a byte-identical string — so cosmetic differences that any
 * reasonable reader would call "the same sentence" must not count as fabrication:
 *
 *   - smart quotes / apostrophes  →  ascii  (models routinely swap these)
 *   - en/em dashes                →  hyphen
 *   - collapsed whitespace, incl. newlines wrapped mid-sentence
 *   - case
 *
 * Everything else — a changed word, a dropped clause, an invented sentence — still fails,
 * which is the point.
 */
export function normalizeForGrounding(text: string): string {
  return text
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type GroundingVerdict =
  /** The excerpt occurs in the source. The citation is real. */
  | 'grounded'
  /** The excerpt does NOT occur in the source — paraphrased or invented. */
  | 'ungrounded'
  /** No excerpt was offered. Honest, and nothing to check. */
  | 'absent'
  /** No source text available to check against (e.g. a binary or remote source). */
  | 'unverifiable';

export interface GroundingResult {
  verdict: GroundingVerdict;
  /** Character offset of the excerpt in the source, when grounded. */
  index?: number;
}

/**
 * Does this excerpt actually appear in the source text?
 *
 * `sourceText` undefined ⇒ 'unverifiable' (we must not claim a citation is fake merely
 * because we could not look). Silence is not evidence of forgery.
 */
export function verifyExcerpt(excerpt: string | undefined, sourceText: string | undefined): GroundingResult {
  if (!excerpt || !excerpt.trim()) return { verdict: 'absent' };
  if (sourceText === undefined || sourceText === null) return { verdict: 'unverifiable' };

  const haystack = normalizeForGrounding(sourceText);
  const needle = normalizeForGrounding(excerpt);
  if (!needle) return { verdict: 'absent' };

  const index = haystack.indexOf(needle);
  return index >= 0 ? { verdict: 'grounded', index } : { verdict: 'ungrounded' };
}

/**
 * Confidence multiplier applied when a model's citation turns out to be fabricated.
 *
 * A model that invents its evidence has told us something real about its reliability on
 * THIS extraction — the fact may still be true, so we do not discard it, but we no longer
 * take its word at face value, and a human should look.
 */
export const UNGROUNDED_CONFIDENCE_PENALTY = 0.6;

export interface GroundableStatement {
  excerpt?: string;
  confidence: number;
  grounded?: boolean;
}

/**
 * Apply the grounding check to one statement-like object.
 *
 * On failure the excerpt is REMOVED. This is deliberate and is the whole point: we would
 * rather show the user no citation than a forged one.
 */
export function groundStatement<T extends GroundableStatement>(st: T, sourceText: string | undefined): T {
  const { verdict } = verifyExcerpt(st.excerpt, sourceText);

  switch (verdict) {
    case 'grounded':
      return { ...st, grounded: true };

    case 'ungrounded':
      return {
        ...st,
        excerpt: undefined, // never render a quote the source does not contain
        grounded: false,
        confidence: Math.max(0, Math.min(1, st.confidence * UNGROUNDED_CONFIDENCE_PENALTY)),
      };

    case 'absent':
    case 'unverifiable':
    default:
      return st; // nothing claimed, or nothing to check it against
  }
}

/** Apply the grounding check to a batch. */
export function groundStatements<T extends GroundableStatement>(
  statements: T[],
  sourceText: string | undefined,
): T[] {
  return statements.map((st) => groundStatement(st, sourceText));
}

/** Count how many of a batch carried a fabricated citation — for surfacing to the user. */
export function countUngrounded(statements: GroundableStatement[]): number {
  return statements.filter((s) => s.grounded === false).length;
}
