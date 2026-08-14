/**
 * Reviewed source copies (F122, phase 1) — the policy half.
 *
 * We keep the LAST REVIEWED version of each source's text on disk so that a refresh can ask
 * "did the document actually change?" BEFORE handing anything to an extractor. Everything in
 * this module is pure policy — what to retain, whether it changed, when to give up and keep a
 * hash — so it is testable without a filesystem. The IO half lives in stores/workspace.
 *
 * WHY THIS EXISTS, in the order the reasons actually matter:
 *
 *  1. LLM EXTRACTION IS NON-DETERMINISTIC. Re-extracting an unchanged document yields slightly
 *     different triples every run, and the triple-level diff faithfully reports all of it as
 *     change. The document did not move; the model did. Comparing documents first removes that
 *     entire false-positive class, because an unchanged source never reaches the extractor.
 *  2. THE FREE CHECK GATES THE EXPENSIVE ONE. A hash comparison costs no tokens and cannot
 *     hallucinate. An automatic poll over a rarely-changing source should cost nothing on the
 *     overwhelming majority of its runs.
 *  3. IT MAKES GROUNDING RE-CHECKABLE. Statement.excerptVerified is documented as
 *     "undefined = not checked (no source text)" precisely because the text was thrown away
 *     after ingest, so a quote could be verified once and never again.
 *
 * TWO RULES THAT ARE EASY TO GET WRONG:
 *
 *  - STORE THE NORMALIZED EXTRACTION, NOT RAW HTML. Navigation, ads, analytics tags, CSRF and
 *    session tokens, "posted 3 days ago" and A/B markup all differ between two fetches of an
 *    IDENTICAL article. Baselining raw HTML would report a change on nearly every poll and
 *    reintroduce the very churn this exists to remove. Callers pass reader-mode/markdown text —
 *    which is also what the extractor consumed, so grounding re-verifies against the same text
 *    the quote came from.
 *  - ONE SLOT PER SOURCE, HOLDING THE LAST REVIEWED VERSION — not the last FETCHED one. If the
 *    baseline advanced on every fetch, a change that arrived and was never reviewed would
 *    silently become the new baseline and vanish from the queue. Advancing only once a review
 *    is settled makes unreviewed changes accumulate into the next diff instead. Callers are
 *    therefore expected to write the baseline at review time, never at fetch time.
 *
 * No history is kept here. The graph carries full, revertable history (archive.ts) and is far
 * more compact than the documents it came from; a source copy is a re-fetchable diff baseline,
 * so keeping every version would buy nothing but bytes. History is for what cannot be re-derived.
 */

/**
 * Per-source retention cap. Past this we keep the hash alone and say so — see `CacheDecision`.
 * Deliberately modest: these bytes cross sync, and the user bounds how MANY sources they watch
 * but not how large any one of them is.
 */
export const SOURCE_CACHE_MAX_BYTES = 2 * 1024 * 1024;

/** Why a refresh decided the way it did. Surfaced to the user, so keep these honest. */
export type ChangeReason =
  /** Nothing retained yet — first sight of this source, so everything is "new". */
  | 'no-baseline'
  /** A baseline exists and the content hash is identical: nothing to extract. */
  | 'unchanged'
  /** A baseline exists and the hash differs: extract, ideally only the changed region. */
  | 'changed'
  /**
   * Too large to retain, so only a hash was kept. We know THAT it changed and not WHAT changed,
   * which means a wholesale re-extract and the return of phantom churn for this source. Callers
   * must report this rather than presenting the diff as precise.
   */
  | 'changed-unretained';

export type SourceBaseline = {
  sourceId: string;
  /** Hash of the normalized text. Always present, even when the body was too big to retain. */
  hash: string;
  /** Byte length of the normalized text at the time it was hashed. */
  bytes: number;
  /** The normalized text, or null when it exceeded the cap and only the hash was kept. */
  text: string | null;
  /** When this baseline was settled by a review. */
  reviewedAt: number;
};

export type CacheDecision = {
  changed: boolean;
  reason: ChangeReason;
  /** True when a full text baseline is available on BOTH sides, so a region diff is possible. */
  canDiffText: boolean;
};

/**
 * SHA-256 of the normalized text, hex-encoded. Uses Web Crypto, which is present in browsers
 * and in Node's global scope, so this stays usable from tests and from a worker.
 */
export async function hashSourceText(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Byte length rather than character length — a cap on storage has to count storage. */
export function sourceTextBytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function withinSizeCap(text: string, maxBytes: number = SOURCE_CACHE_MAX_BYTES): boolean {
  return sourceTextBytes(text) <= maxBytes;
}

/**
 * Build the baseline record to retain for a source whose review has just been settled.
 * Over the cap we keep the hash and drop the body, which is a real loss of precision and is
 * reported as such by `classifyChange` on the next refresh.
 */
export async function makeBaseline(
  sourceId: string,
  text: string,
  reviewedAt: number,
  maxBytes: number = SOURCE_CACHE_MAX_BYTES
): Promise<SourceBaseline> {
  const bytes = sourceTextBytes(text);
  return {
    sourceId,
    hash: await hashSourceText(text),
    bytes,
    text: bytes <= maxBytes ? text : null,
    reviewedAt
  };
}

/**
 * The gate a refresh runs before extracting anything.
 *
 * Note what is NOT here: no HTTP conditional request and no feed check. Those are cheaper still
 * and belong upstream of this call (F122's ladder) — by the time we are comparing hashes we have
 * already paid for a fetch.
 */
export function classifyChange(
  baseline: SourceBaseline | null,
  incomingHash: string,
  incomingText: string | null = null
): CacheDecision {
  if (!baseline) {
    return { changed: true, reason: 'no-baseline', canDiffText: false };
  }
  if (baseline.hash === incomingHash) {
    return { changed: false, reason: 'unchanged', canDiffText: false };
  }
  if (baseline.text === null) {
    // We kept only a hash for this one, so we can say it moved but not where.
    return { changed: true, reason: 'changed-unretained', canDiffText: false };
  }
  return { changed: true, reason: 'changed', canDiffText: incomingText !== null };
}

/**
 * A human-readable account of a decision, for the refresh UI and logs.
 * Says the weakness out loud in the sentence that describes the thing (kb:honest-status):
 * an unretained source is reported as imprecise rather than quietly treated as precise.
 */
export function describeDecision(decision: CacheDecision): string {
  switch (decision.reason) {
    case 'no-baseline':
      return 'No retained copy yet — everything from this source is treated as new.';
    case 'unchanged':
      return 'Unchanged since the last reviewed copy — nothing extracted.';
    case 'changed':
      return 'Changed since the last reviewed copy.';
    case 'changed-unretained':
      return 'Changed, but the previous copy was too large to retain — we know that it changed, not what changed, so this was re-read in full.';
  }
}
