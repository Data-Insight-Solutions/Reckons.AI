/**
 * Source document (F221 / kb:source-corpus, UI source side) — pure derivation.
 *
 * The statement side (statement-evidence.ts) answers "which passage did this statement come
 * from?". This is the same join read the other way: cut a source's retained text into passages
 * with the same deterministic chunker, place every statement of that source in the passage its
 * excerpt anchors to, and count each passage's statements by review status.
 *
 * HONESTY RULES: a statement is placed only where its excerpt is actually found (anchorExcerpt);
 * everything else is listed as unplaced WITH the reason, never guessed into a passage. A passage
 * with no statements is NOT described as "not read yet": extraction does not run per passage, so
 * nothing records which passages a model saw. It only says no statement was placed there.
 */
import type { ReviewStatus, Statement } from '../rdf/types';
import { anchorExcerpt, chunkText, type ChunkOptions } from './source-chunks';

/** Display order: settled first, then waiting on a person, then dismissed. */
export const STATUS_ORDER: readonly ReviewStatus[] = [
  'confirmed', 'refined', 'pending', 'pending-removal', 'rejected', 'superseded',
];

export type Passage = {
  /** 0-based chunk index (matches statement-evidence's chunkIndex), and 1-based for display. */
  index: number;
  number: number;
  text: string;
  statements: Statement[];
  counts: Partial<Record<ReviewStatus, number>>;
};

export type UnplacedReason = 'no-excerpt' | 'not-in-source' | 'not-found';

export type SourceDocument =
  | { kind: 'document'; passages: Passage[]; unplaced: { statement: Statement; reason: UnplacedReason }[] }
  | { kind: 'no-text'; statementCount: number };

export function countByStatus(statements: readonly Statement[]): Partial<Record<ReviewStatus, number>> {
  const counts: Partial<Record<ReviewStatus, number>> = {};
  for (const st of statements) counts[st.status] = (counts[st.status] ?? 0) + 1;
  return counts;
}

export function deriveSourceDocument(
  text: string | null | undefined,
  statements: readonly Statement[],
  opts: ChunkOptions = {},
): SourceDocument {
  if (!text) return { kind: 'no-text', statementCount: statements.length };
  const chunks = chunkText(text, opts);
  const placed: Statement[][] = chunks.map(() => []);
  const unplaced: { statement: Statement; reason: UnplacedReason }[] = [];
  for (const statement of statements) {
    const excerpt = statement.excerpt?.trim();
    if (!excerpt) { unplaced.push({ statement, reason: 'no-excerpt' }); continue; }
    // Extraction already checked this quote against the source and found it absent: do not
    // re-anchor it here, or the two views would disagree about the same statement.
    if (statement.grounded === false) { unplaced.push({ statement, reason: 'not-in-source' }); continue; }
    const anchor = anchorExcerpt(text, excerpt, chunks);
    if (!anchor) { unplaced.push({ statement, reason: 'not-found' }); continue; }
    placed[anchor.chunkIndex].push(statement);
  }
  return {
    kind: 'document',
    passages: chunks.map((chunk, i) => ({
      index: chunk.index,
      number: chunk.index + 1,
      text: chunk.text,
      statements: placed[i],
      counts: countByStatus(placed[i]),
    })),
    unplaced,
  };
}

/** "2 confirmed · 1 pending", in STATUS_ORDER; null when the passage holds no statements. */
export function statusSummary(counts: Partial<Record<ReviewStatus, number>>): string | null {
  const parts = STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s.replace('-', ' ')}`);
  return parts.length ? parts.join(' · ') : null;
}

/** A passage's statements grouped by status, in STATUS_ORDER, empty groups omitted. */
export function groupByStatus(statements: readonly Statement[]): { status: ReviewStatus; statements: Statement[] }[] {
  return STATUS_ORDER
    .map((status) => ({ status, statements: statements.filter((st) => st.status === status) }))
    .filter((g) => g.statements.length > 0);
}

/** One plain sentence per degraded case, for the component to render as-is. */
export function sourceDocumentNotice(doc: SourceDocument): string | null {
  if (doc.kind === 'no-text') {
    return 'The full text of this source was not kept, so its passages cannot be shown. Sources added before text was kept, and graphs imported as files, have no retained text.';
  }
  return null;
}

export const UNPLACED_REASON: Record<UnplacedReason, string> = {
  'no-excerpt': 'no quoted excerpt was saved',
  'not-in-source': 'the saved quote was not found in the source when extracted',
  'not-found': 'the saved quote is not in the text that was kept (the source may have changed)',
};

export const EMPTY_PASSAGE_NOTE =
  'No statement was placed in this passage. This does not mean it was skipped: which passages extraction read is not recorded yet.';
