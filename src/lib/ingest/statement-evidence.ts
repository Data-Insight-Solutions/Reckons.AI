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

export type EvidenceInput = {
  sourceTitle: string;
  /** The statement's verbatim excerpt, if it has one. */
  excerpt?: string | null;
  /** Source text retained from the last review; null/undefined when none was kept. */
  sourceText?: string | null;
  /** `false` means extraction already found the excerpt was not in the source and dropped it. */
  grounded?: boolean;
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
  | { kind: 'none'; sourceTitle: string; reason: 'no-excerpt' };

export function deriveEvidence(input: EvidenceInput, opts: ChunkOptions = {}): Evidence {
  const { sourceTitle } = input;
  const excerpt = input.excerpt?.trim() ?? '';
  if (!excerpt) return { kind: 'none', sourceTitle, reason: 'no-excerpt' };
  if (input.grounded === false) return { kind: 'excerpt-only', sourceTitle, reason: 'not-in-source' };
  const text = input.sourceText;
  if (!text) return { kind: 'excerpt-only', sourceTitle, excerpt, reason: 'no-source-text' };

  const chunks = chunkText(text, opts);
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
