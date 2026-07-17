/**
 * Lexical similarity — a deterministic, offline similarity source for the merge SUGGEST tier.
 *
 * The decided merge band (kb:auto-merge, merge-band.ts) is SEMANTIC at heart — a synonym is a
 * likely connection, so embeddings are the real answer (kb:embedding-model). But embeddings need a
 * model and a runtime; this is the free first cut: token-set Jaccard over the facts' text. It runs
 * anywhere, costs nothing, and is right about the easy cases ("ships on Friday" vs "ships Friday"),
 * which is exactly the work-tiering rule — the cheapest tier that can do it correctly, with
 * embeddings as the refinement, not the default.
 *
 * It is honest about its own weakness: Jaccard sees SHARED WORDS, not shared meaning, so a synonym
 * pair ("car"/"automobile") scores 0. That is why it feeds the SUGGEST tier (a human reviews),
 * never the auto tier — a lexical score must never silently merge anything. The predicate is the
 * main clue to a valid link (kb:predicate-economy), so callers compare only same-predicate facts.
 */
import type { Statement, Term } from './types';

/** Very small stopword set — the words that are shared by everything and mean nothing for overlap. */
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'or', 'is', 'in', 'on', 'for', 'with', 'at', 'by', 'it']);

/** Lowercase, split on non-alphanumerics, drop stopwords and 1-char tokens. */
export function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok.length > 1 && !STOP.has(tok)) out.add(tok);
  }
  return out;
}

/** Jaccard overlap of two token sets: |A∩B| / |A∪B|. Empty-vs-empty is 0 (no evidence, not identity). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * The human-readable text of a term: a literal's value, or the last segment of an IRI (split on
 * '/', '#' AND ':' so URI scheme noise like "urn:" does not become a shared token that makes every
 * urn: subject look alike).
 */
function termText(t: Term): string {
  if (t.kind === 'literal') return t.value;
  return t.value.split(/[/#:]/).pop() ?? t.value;
}

/**
 * Lexical similarity between two facts, in [0,1]. The subject and the object are compared
 * SEPARATELY and the MINIMUM is returned: two facts are the same only if BOTH their subjects and
 * their objects match. Comparing the combined bag of words instead would let an identical subject
 * inflate the score for facts whose OBJECTS differ — i.e. flag two different VALUES of the same
 * attribute as a duplicate, which they are not (that is a dichotomy, not a dupe). The predicate is
 * assumed to already agree (the caller's job). Deterministic and symmetric.
 */
export function lexicalFactSimilarity(a: Statement, b: Statement): number {
  const subjSim = jaccard(tokenize(termText(a.s)), tokenize(termText(b.s)));
  const objSim = jaccard(tokenize(termText(a.o)), tokenize(termText(b.o)));
  return Math.min(subjSim, objSim);
}
