/**
 * Matches event text (title + description) against existing KB entity labels.
 * Returns IRIs of entities whose labels appear in the event text.
 */

import type { Statement } from './types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

// Common words to skip when matching (would cause false positives)
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those',
  'it', 'its', 'not', 'no', 'if', 'then', 'so', 'as', 'we', 'our',
  'you', 'your', 'they', 'their', 'he', 'she', 'his', 'her', 'all',
  'each', 'every', 'any', 'some', 'more', 'most', 'other', 'new',
  'about', 'up', 'out', 'just', 'also', 'very', 'how', 'when', 'where',
  'what', 'which', 'who', 'why', 'now', 'here', 'there', 'am', 'pm'
]);

/**
 * Find existing KB entities whose labels match words/phrases in the given text.
 * Returns an array of entity IRIs that are related to the event content.
 */
export function findRelatedEntities(text: string, existingStatements: Statement[]): string[] {
  if (!text.trim() || !existingStatements.length) return [];

  // Build a map of entity labels → IRIs from confirmed statements
  const labelToIri = new Map<string, string>();
  for (const stmt of existingStatements) {
    if (
      stmt.p.value === RDFS_LABEL &&
      stmt.status === 'confirmed' &&
      stmt.o.kind === 'literal' &&
      stmt.s.kind === 'iri'
    ) {
      const label = stmt.o.value.toLowerCase().trim();
      // Skip very short labels (1-2 chars) — too many false positives
      if (label.length > 2) {
        labelToIri.set(label, stmt.s.value);
      }
    }
  }

  if (labelToIri.size === 0) return [];

  const textLower = text.toLowerCase();
  const matched = new Set<string>();

  for (const [label, entityIri] of labelToIri) {
    // Skip if the label is a single stop word
    if (STOP_WORDS.has(label)) continue;

    // Check if the label appears as a whole word/phrase in the text
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(textLower)) {
      matched.add(entityIri);
    }
  }

  return [...matched];
}
