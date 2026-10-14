/**
 * Statement evidence (F221 / kb:source-corpus, UI statement side) — pure derivation.
 *
 * A statement detail answers "where exactly did this come from?" by cutting the source text into
 * passages (chunkText) and locating the statement's verbatim excerpt in one of them
 * (anchorExcerpt). Nothing is persisted yet: chunks.ttl and kept originals are not built, so this
 * is derived at view time from whatever source text is retained. Because the cut is deterministic,
 * "passage 3 of 12" is stable for one version of a source.
 *
 * HONESTY RULES: never guess a span (no anchor => say why and show the excerpt alone); never
 * claim page ranges or heading paths the chunker does not produce (they are not in `Chunk`).
 * Plain wording lives in `evidenceNotice`, so the component stays a thin renderer.
 */
import { anchorExcerpt, chunkText, type ChunkOptions } from './source-chunks';
import { normalizeForGrounding } from '../rdf/grounding';
import type { EvidenceSpan } from '../rdf/types';

export type EvidenceInput = {
  sourceTitle: string;
  /** The statement's verbatim excerpt, if it has one. */
  excerpt?: string | null;
  /** Source text retained from the last review; null/undefined when none was kept. */
  sourceText?: string | null;
  /** `false` means extraction already found the excerpt was not in the source and dropped it. */
  grounded?: boolean;
  /** The span stored when the fact was extracted (F122.1.1). Preferred when it still checks out. */
  anchor?: EvidenceSpan;
  /** Hash of the retained revision `sourceText` belongs to; the anchor is compared against it. */
  retainedHash?: string;
};

export type Evidence =
  | {
      kind: 'anchored';
      sourceTitle: string;
      /** 1-based position for display, and the total. */
      passageNumber: number;
      passageCount: number;
      /** 0-based chunk index, for deep links. */
      chunkIndex: number;
      before: string;
      highlight: string;
      after: string;
      match: 'exact' | 'normalized';
      /** The supporting span runs past the end of this passage into the next. */
      continuesInNext: boolean;
    }
  | {
      kind: 'excerpt-only';
      sourceTitle: string;
      /** Absent when extraction found the saved quote was not in the source: it is not shown. */
      excerpt?: string;
      reason: 'no-source-text' | 'not-found' | 'not-in-source';
    }
  | {
      /**
       * A stored anchor that no longer checks out (F122.1.3): the document changed since the fact was
       * extracted. The saved quote is shown as the evidence; no passage is marked, because marking
       * one would present a guess as a verified place.
       */
      kind: 'stale';
      sourceTitle: string;
      excerpt: string;
      reason: 'source-changed' | 'span-moved';
    }
  | { kind: 'none'; sourceTitle: string; reason: 'no-excerpt' };

/**
 * Does a stored anchor still hold? Two deterministic checks: the document revision is the one it was
 * computed against, and the span of the retained text still reads as the saved quote (same leniency
 * as grounding: case, spacing, quote marks). Editing one character before the span moves it and fails
 * the second check even when the hash is unavailable.
 */
export function checkAnchor(
  anchor: EvidenceSpan,
  text: string,
  excerpt: string,
  retainedHash?: string,
): { ok: true; match: 'exact' | 'normalized' } | { ok: false; reason: 'source-changed' | 'span-moved' } {
  if (retainedHash && anchor.sourceHash !== retainedHash) return { ok: false, reason: 'source-changed' };
  if (!(anchor.start >= 0 && anchor.end > anchor.start && anchor.end <= text.length)) return { ok: false, reason: 'span-moved' };
  const held = text.slice(anchor.start, anchor.end);
  const quote = excerpt.trim();
  if (held.trim() === quote) return { ok: true, match: 'exact' };
  if (normalizeForGrounding(held) === normalizeForGrounding(quote)) return { ok: true, match: 'normalized' };
  return { ok: false, reason: 'span-moved' };
}

export function deriveEvidence(input: EvidenceInput, opts: ChunkOptions = {}): Evidence {
  const { sourceTitle } = input;
  const excerpt = input.excerpt?.trim() ?? '';
  if (!excerpt) return { kind: 'none', sourceTitle, reason: 'no-excerpt' };
  if (input.grounded === false) return { kind: 'excerpt-only', sourceTitle, reason: 'not-in-source' };
  const text = input.sourceText;
  if (!text) return { kind: 'excerpt-only', sourceTitle, excerpt, reason: 'no-source-text' };

  const chunks = chunkText(text, opts);
  if (input.anchor) {
    // A stored anchor is preferred and verified. When it fails the fact is NOT silently re-located:
    // a moved quote is a changed document, and the person is told so.
    const check = checkAnchor(input.anchor, text, excerpt, input.retainedHash);
    if (!check.ok) return { kind: 'stale', sourceTitle, excerpt, reason: check.reason };
    const chunk = chunks.find((c) => input.anchor!.start >= c.start && input.anchor!.start < c.end);
    if (chunk) {
      const hlEnd = Math.min(input.anchor.end, chunk.end);
      return {
        kind: 'anchored',
        sourceTitle,
        passageNumber: chunk.index + 1,
        passageCount: chunks.length,
        chunkIndex: chunk.index,
        before: text.slice(chunk.start, input.anchor.start),
        highlight: text.slice(input.anchor.start, hlEnd),
        after: text.slice(hlEnd, chunk.end),
        match: check.match,
        continuesInNext: input.anchor.end > chunk.end,
      };
    }
  }
  const anchor = anchorExcerpt(text, excerpt, chunks);
  if (!anchor) return { kind: 'excerpt-only', sourceTitle, excerpt, reason: 'not-found' };
  const chunk = chunks[anchor.chunkIndex];
  const hlEnd = Math.min(anchor.end, chunk.end);
  return {
    kind: 'anchored',
    sourceTitle,
    passageNumber: chunk.index + 1,
    passageCount: chunks.length,
    chunkIndex: chunk.index,
    before: text.slice(chunk.start, anchor.start),
    highlight: text.slice(anchor.start, hlEnd),
    after: text.slice(hlEnd, chunk.end),
    match: anchor.match,
    continuesInNext: anchor.end > chunk.end,
  };
}

/** One plain sentence explaining a degraded case; null when the evidence is fully anchored. */
export function evidenceNotice(e: Evidence): string | null {
  if (e.kind === 'anchored') {
    const parts: string[] = [];
    if (e.match === 'normalized') parts.push('Line breaks or spacing differ slightly from the quote.');
    if (e.continuesInNext) parts.push('The supporting text continues into the next passage.');
    return parts.length ? parts.join(' ') : null;
  }
  if (e.kind === 'none') return 'This statement has no quoted excerpt, so there is no passage to show.';
  if (e.kind === 'stale') {
    return e.reason === 'source-changed'
      ? 'The source changed since this was extracted, so the passage it came from cannot be shown. The quote saved with the statement is the only evidence.'
      : 'The text where this was found has moved or changed since it was extracted, so no passage is marked. The quote saved with the statement is the only evidence.';
  }
  switch (e.reason) {
    case 'no-source-text':
      return 'The full text of this source was not kept, so the exact passage cannot be shown. The quote saved with the statement is the only evidence.';
    case 'not-in-source':
      return 'The quote saved with this statement was not found in the source when it was checked, so it is not shown as evidence.';
    case 'not-found':
      return 'The saved quote could not be found in the source text that was kept (the source may have changed). The quote saved with the statement is the only evidence.';
  }
}

/** Page ranges, heading paths and a retained original are not produced yet; the UI says so once. */
export const EVIDENCE_LIMITS_NOTE =
  'Page numbers, section headings and a copy of the original file are not kept yet.';
