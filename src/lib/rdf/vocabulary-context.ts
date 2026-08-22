/**
 * Vocabulary grounding (F136) — tell the extractor the words this graph already uses, before it
 * invents its own.
 *
 * THE PROBLEM THIS SOLVES, MEASURED. Extraction is vocabulary-blind: `buildExtractionUserPrompt`
 * hands the model the source text and a title and nothing about the graph it is writing into. So a
 * local model reaches for whatever the source text suggested, and on 2026-08-15 qwen3.6 emitted
 * `has-number-of-hearts` where the graph says `has-heart-count`, and `has-habitat` twice where the
 * graph says `is-found-in`. Fact recall was 44.4%; vocabulary agreement on those found facts was
 * 62.5%. Roughly a third of what the score called failure was the model finding the right fact and
 * calling it something else.
 *
 * WHY NOT JUST FIX IT AFTERWARDS. `normalize-entities.ts` already tries, by rewriting an incoming
 * predicate onto an existing one at cosine >= 0.88. Benchmarked across five embedding models
 * (`npm run bench:predicates`), it does not work on this problem: the shipped model catches 16.7%
 * of synonym pairs and misses the observed case at 0.803, and EVERY model tested had negative
 * separation — its worst true synonym scored below its closest distinct-but-different pair. No
 * threshold separates them. Repair after the fact is the wrong place to stand; the cheap fix is to
 * ask better.
 *
 * SCRIPT TIER BY CONSTRUCTION (F74.3). Selection here is deterministic — frequency plus lexical
 * overlap with the source text. No embedding call, no model, no tokens, and it therefore works on
 * the offline WASM path and in tests without a network. An embedding-ranked variant is the obvious
 * upgrade and is deliberately not taken first: the benchmark above is a standing reminder that
 * cosine similarity over short predicate labels is a weaker signal than it looks.
 */

import type { Statement } from './types';

/** Standard vocabularies are never offered as "our words" — they are everyone's words. */
const PROTECTED_PREFIXES = [
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/2000/01/rdf-schema#',
  'http://www.w3.org/2004/02/skos/core#',
  'http://www.w3.org/2001/XMLSchema#',
];

/**
 * Generic predicates that carry a relation and no knowledge. graph-lint already warns about these
 * (`relates-to` alone is 3.2% of the graph); offering them as vocabulary would actively teach the
 * model to reach for the emptiest edge available.
 */
const GENERIC_PREDICATES = new Set(['relates-to', 'related', 'link', 'links-to', 'associated-with']);

/**
 * A predicate used once is a private word that generalized nothing — 24% of this graph's predicate
 * types, per graph-lint. Offering the long tail would teach the model that minting one-offs is the
 * house style, which is the opposite of the point.
 */
const DEFAULT_MIN_USES = 2;

/** How many predicates to offer. Small models follow a short list; a long one becomes noise. */
const DEFAULT_PREDICATE_BUDGET = 40;

/** Entities are offered so the model reuses an existing subject rather than minting a near-twin. */
const DEFAULT_ENTITY_BUDGET = 25;

export interface VocabularyEntry {
  /** Kebab-case slug, exactly as the extractor is asked to emit it. */
  slug: string;
  /** How many statements in the graph use it. */
  count: number;
  /** True when the slug's words appear in the source text. */
  mentioned: boolean;
}

export interface VocabularyContext {
  predicates: VocabularyEntry[];
  entities: VocabularyEntry[];
  /** Distinct non-protected predicate types in the graph, before budgeting. */
  totalPredicates: number;
  /** True when the budget cut the list — the prompt says so, so the model knows it is a sample. */
  truncated: boolean;
}

export interface SelectVocabularyOptions {
  predicateBudget?: number;
  entityBudget?: number;
  minUses?: number;
}

// ── Slug handling ────────────────────────────────────────────────────────────

/**
 * Last path segment of an IRI — the kebab-case slug the extractor emits and the graph stores.
 *
 * Deliberately NOT `labelFromIRI` from semantic-diff, which converts hyphens to spaces for
 * embedding. Here the exact slug is the point: the model is being shown the literal string it
 * should reuse, and `has heart count` is not a string it can copy.
 */
export function slugFromIRI(iriValue: string): string {
  const hashed = iriValue.split('#').pop() ?? iriValue;
  return (hashed.split('/').pop() ?? hashed).trim();
}

function isProtected(iriValue: string): boolean {
  return PROTECTED_PREFIXES.some((p) => iriValue.startsWith(p));
}

/**
 * Words that are STRUCTURAL in a predicate slug rather than topical.
 *
 * Found by a failing test, which is why the list is this specific. `has-heart-count` describes a
 * text about hearts and counts — but that text says "have three hearts", never the bare token
 * "has", so requiring every word matched nothing and relevance ranking silently never fired. These
 * words prefix a large share of predicates and carry no subject matter, so they are excluded from
 * the topic check for the same reason two-letter words are.
 */
const STRUCTURAL_SLUG_WORDS = new Set([
  'has', 'have', 'had', 'was', 'were', 'been', 'being',
  'the', 'and', 'for', 'with', 'its', 'their',
]);

/** Topical words of a slug, for lexical overlap against the source text. */
function slugWords(slug: string): string[] {
  return slug
    .toLowerCase()
    .split(/[-_\s]+/)
    .filter((w) => w.length > 2 && !STRUCTURAL_SLUG_WORDS.has(w));
}

/**
 * Does the source text mention what this slug is about?
 *
 * Requires EVERY significant word, not any: `has-heart-count` should match a text about hearts and
 * counts, while `has-blood-color` should not match merely because the word "has" appears. A slug
 * whose words are all stopwords (none longer than two characters) can never be "mentioned",
 * which is correct — it carries no topic to match on.
 */
function isMentionedIn(slug: string, textWords: Set<string>): boolean {
  const words = slugWords(slug);
  if (words.length === 0) return false;
  return words.every((w) => textWords.has(w));
}

function textWordSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

// ── Selection ────────────────────────────────────────────────────────────────

function rank(a: VocabularyEntry, b: VocabularyEntry): number {
  // Relevance first: a predicate the source text is actually about beats a commoner one it isn't.
  if (a.mentioned !== b.mentioned) return a.mentioned ? -1 : 1;
  // Then frequency — the graph's established words before its occasional ones.
  if (a.count !== b.count) return b.count - a.count;
  // Then alphabetical, so the same graph always yields the same prompt. Stable ordering is not
  // cosmetic: an unstable list would change the prompt prefix on every call and defeat caching.
  return a.slug.localeCompare(b.slug);
}

/**
 * Chooses the slice of the graph's vocabulary worth showing the extractor for THIS source text.
 */
export function selectVocabulary(
  existing: Statement[],
  sourceText: string,
  opts: SelectVocabularyOptions = {},
): VocabularyContext {
  const predicateBudget = opts.predicateBudget ?? DEFAULT_PREDICATE_BUDGET;
  const entityBudget = opts.entityBudget ?? DEFAULT_ENTITY_BUDGET;
  const minUses = opts.minUses ?? DEFAULT_MIN_USES;
  const words = textWordSet(sourceText);

  const predicateCounts = new Map<string, number>();
  const entityCounts = new Map<string, number>();

  for (const st of existing) {
    if (!isProtected(st.p.value)) {
      const slug = slugFromIRI(st.p.value);
      if (slug && !GENERIC_PREDICATES.has(slug)) {
        predicateCounts.set(slug, (predicateCounts.get(slug) ?? 0) + 1);
      }
    }
    // Subjects and IRI objects both name entities; a thing referred to only as an object is still
    // a thing the extractor should reuse rather than mint again under another name.
    for (const term of [st.s, st.o]) {
      if (term.kind !== 'iri' || isProtected(term.value)) continue;
      const slug = slugFromIRI(term.value);
      if (slug) entityCounts.set(slug, (entityCounts.get(slug) ?? 0) + 1);
    }
  }

  const totalPredicates = predicateCounts.size;

  const toEntries = (counts: Map<string, number>, floor: number): VocabularyEntry[] =>
    [...counts.entries()]
      .filter(([, count]) => count >= floor)
      .map(([slug, count]) => ({ slug, count, mentioned: isMentionedIn(slug, words) }))
      .sort(rank);

  const rankedPredicates = toEntries(predicateCounts, minUses);
  // Entities have no minimum: a subject mentioned once is still the subject a new fact about it
  // belongs to, and duplicating it is exactly the failure normalize-entities exists to clean up.
  const rankedEntities = toEntries(entityCounts, 1);

  return {
    predicates: rankedPredicates.slice(0, predicateBudget),
    entities: rankedEntities.slice(0, entityBudget),
    totalPredicates,
    truncated: rankedPredicates.length > predicateBudget,
  };
}

// ── Prompt rendering ─────────────────────────────────────────────────────────

/**
 * Renders the vocabulary as a PREFERENCE, never as a closed list.
 *
 * THE CONSTRAINT THAT SHAPES EVERY WORD HERE (recorded on F136): grounding must not become a cage.
 * A prompt that enumerates the graph's predicates and demands the model pick one would suppress
 * genuinely new relations — and a well-formed absence is the most valuable node in the graph
 * (kb:thesis). So the section says "prefer" and says out loud that minting a new predicate is
 * correct when nothing here fits. The instruction not to force a bad fit is load-bearing: without
 * it, a list of forty plausible-looking predicates is an invitation to jam every fact into one.
 *
 * Returns '' when there is nothing worth saying, so a first ingest into an empty graph pays no
 * tokens and reads exactly as it did before this feature existed.
 */
export function buildVocabularySection(ctx: VocabularyContext): string {
  if (ctx.predicates.length === 0 && ctx.entities.length === 0) return '';

  const lines: string[] = ['', '---', 'THIS GRAPH ALREADY USES THESE WORDS. Prefer them over synonyms of your own.'];

  if (ctx.predicates.length > 0) {
    const shown = ctx.predicates.map((p) => p.slug).join(', ');
    lines.push('');
    lines.push(
      ctx.truncated
        ? `Existing predicates (${ctx.predicates.length} of ${ctx.totalPredicates} most relevant): ${shown}`
        : `Existing predicates: ${shown}`,
    );
  }

  if (ctx.entities.length > 0) {
    lines.push('');
    lines.push(`Existing entities: ${ctx.entities.map((e) => e.slug).join(', ')}`);
  }

  lines.push('');
  lines.push(
    'If one of these expresses the relation you found, reuse it EXACTLY as written — "has-heart-count", not "has-number-of-hearts". Reuse an existing entity slug rather than minting a near-duplicate of it.',
  );
  lines.push(
    'If none of them fits, mint a new predicate that names the relation precisely. Do NOT force a fact into a listed predicate that does not mean what the source says, and do not fall back to a vague one — a new, well-named relation is better than a wrong familiar one.',
  );

  return lines.join('\n');
}
