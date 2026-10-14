/**
 * Does every stored anchor point at a passage that is really there? (F122.1.2, script tier)
 *
 * An anchor names a chunk by IRI and a span by offsets. Existence is deterministic, so it is checked
 * by rule and never left to a model: the chunk entry must be in the same file, must belong to the
 * fact's own document, and must contain the span's start. Whether the passage SUPPORTS the fact is a
 * person's judgement and is not asked here.
 */
import type { Statement } from '../rdf/types';
import type { ImportedChunk } from '../rdf/import-ttl';

export type AnchorProblem = {
  statementId: string;
  chunk: string;
  reason: 'no-such-chunk' | 'other-source' | 'start-outside-chunk';
};

export function unresolvedAnchors(
  statements: ReadonlyArray<Pick<Statement, 'id' | 'sourceId' | 'anchor'>>,
  chunks: ReadonlyArray<Pick<ImportedChunk, 'iri' | 'sourceId' | 'start' | 'end'>>,
): AnchorProblem[] {
  const byIri = new Map(chunks.map((c) => [c.iri, c]));
  const out: AnchorProblem[] = [];
  for (const s of statements) {
    if (!s.anchor) continue;
    const c = byIri.get(s.anchor.chunk);
    if (!c) { out.push({ statementId: s.id, chunk: s.anchor.chunk, reason: 'no-such-chunk' }); continue; }
    if (c.sourceId !== s.sourceId) { out.push({ statementId: s.id, chunk: s.anchor.chunk, reason: 'other-source' }); continue; }
    if (s.anchor.start < c.start || s.anchor.start >= c.end) out.push({ statementId: s.id, chunk: s.anchor.chunk, reason: 'start-outside-chunk' });
  }
  return out;
}
