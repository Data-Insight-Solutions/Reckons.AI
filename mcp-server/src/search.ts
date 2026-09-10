/**
 * BM25 search over triples — same algorithm as src/lib/rdf/bm25.ts
 * duplicated here so the MCP server has no dependency on the browser bundle.
 *
 * Caches tokenization so repeated searches against the same triple set
 * don't re-tokenize on every call.
 *
 * ALIAS EXPANSION (kb:node-synonyms phase 2). Every triple is indexed under its subject's
 * skos:altLabel values as well as its own text, so a fact recorded under one name is findable
 * by every other name that entity answers to. This is the VOCABULARY half of F104: BM25 scores
 * literal token overlap, so before this, an entity called "Ava Growers Market" was simply
 * unreachable by the name a source actually used, and search returned nothing — which reads
 * identically to the fact not existing.
 *
 * Expansion is applied on the DOCUMENT side rather than the query side, because the goal is to
 * reach an entity's OTHER facts through its alias, not merely to match the alias triple itself
 * (that one already matched — its object is the alias string). It costs document length, which
 * BM25 normalises against, so a heavily aliased entity is mildly penalised on every triple;
 * the benchmark measures that trade rather than assuming it away.
 *
 * MATCH ATTRIBUTION IS NOT OPTIONAL. kb:node-synonyms: "the result must show WHICH ALIAS
 * MATCHED — unexplained recall is no better than unexplained silence, and it is worse in one
 * way, because it looks like it worked." So every result reports the aliases that earned it,
 * and a caller that does not surface them is misreporting the search.
 */

import type { Triple } from './kb-reader.js';

const K1 = 1.5;
const B  = 0.75;

const SKOS_ALT_LABEL = 'http://www.w3.org/2004/02/skos/core#altLabel';

/**
 * How strongly a matched alias boosts an entity's triples, relative to the entity's own text
 * containing the same query terms once.
 *
 * 1.0 would say "reached by a synonym is exactly as good as stated outright". It is not: a
 * direct hit should win, so the default sits below 1.
 *
 * WHY A SCORE BONUS AND NOT INDEX EXPANSION. The first implementation appended each subject's
 * aliases to the text of every one of its triples. The benchmark falsified that design twice
 * over, and both failures are instructive:
 *
 *   1. LENGTH. Appending aliases lengthens every triple of an aliased entity, and BM25
 *      normalises by document length — so adding the alias "Model Context Protocol server" to
 *      kb:mcp-server pushed its own triples from rank 1 to rank 4 for the direct query
 *      "MCP server". Documenting a synonym made the entity harder to find by its real name.
 *
 *   2. IDF. Spraying a short alias across every triple of an entity multiplies that term's
 *      document frequency, and idf is the inverse of it. Adding "KB" to kb:knowledge-graph
 *      made "kb" look common, so the query "KB" fell out of the top 10 entirely — the alias
 *      destroyed the discriminating power of the exact term it was added to serve.
 *
 * Scoring the alias separately leaves the BM25 index completely untouched, so a query that
 * worked before scores identically after. Recall is added; nothing is disturbed to get it.
 *
 * 0.8 IS MEASURED, NOT ARGUED. tests/bench/run-synonym-search-bench.ts sweeps this against the
 * real 12.5k-triple static/ corpus. 0 reproduces plain BM25 exactly (the sanity check that the
 * bonus is the only difference); the knee is at 0.4; and 0.8 is where BOTH arms saturate —
 * synonym-phrased queries and the control queries that already worked each reach 100% top-1
 * and MRR 1.000. It stops below 1.0 because 1.0 would say a synonym is worth exactly as much
 * as stating the name outright, and a direct hit should stay strictly stronger.
 */
export const ALIAS_TERM_WEIGHT = 0.8;

/**
 * DELIBERATELY NO COVERAGE FLOOR. An earlier version required an alias to have at least half
 * its tokens present in the query before it counted, on the theory that one word out of three
 * is too weak a signal. The benchmark disagreed: removing the floor left the synonym arm
 * unchanged and IMPROVED the control arm (top-1 66.7% → 83.3%), because idf already does the
 * job a floor was trying to do. A rare covered term like "farmers" carries real mass; a common
 * one like "the" carries almost none. Weighting by idf is self-regulating, and a hard floor
 * only discards the partial matches that were worth having.
 */

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function tripleText(t: Triple): string {
  const subjectSlug = t.subject.split('/').pop() ?? t.subject;
  const predicateSlug = t.predicate.split('/').pop() ?? t.predicate;
  return `${subjectSlug} ${predicateSlug} ${t.object}`;
}

/** subject IRI → the alternate names it answers to. */
export type AliasIndex = Map<string, string[]>;

/**
 * Collect skos:altLabel values per subject.
 *
 * Literal objects only: an altLabel pointing at an IRI is malformed SKOS, and indexing the IRI
 * text would inject slug noise into every triple of the entity.
 */
export function buildAliasIndex(triples: Triple[]): AliasIndex {
  const index: AliasIndex = new Map();
  for (const t of triples) {
    if (t.predicate !== SKOS_ALT_LABEL || !t.objectIsLiteral) continue;
    const value = t.object.trim();
    if (!value) continue;
    const list = index.get(t.subject);
    if (list) {
      if (!list.some((v) => v.toLowerCase() === value.toLowerCase())) list.push(value);
    } else {
      index.set(t.subject, [value]);
    }
  }
  return index;
}

export type SearchResult = {
  triple: Triple;
  score: number;
  /**
   * Aliases of this triple's subject that the query hit. Empty when the triple matched on its
   * own text — the honest signal that recall here did NOT depend on the thesaurus.
   */
  matchedAliases?: string[];
};

// ── Tokenization cache ──────────────────────────────────────────────────────

type TokenCache = {
  tripleCount: number;
  tokenized: string[][];
  df: Map<string, number>;
  avgdl: number;
  aliasIndex: AliasIndex;
};

let cache: TokenCache | null = null;
let cacheTriples: Triple[] | null = null;

function getTokenCache(triples: Triple[]): TokenCache {
  // The index no longer depends on whether aliases are in play — that is the whole point of
  // scoring them separately — so the cache key is just the triple array again.
  if (cache && cacheTriples === triples && cache.tripleCount === triples.length) {
    return cache;
  }

  const tokenized = triples.map(t => tokenize(tripleText(t)));
  const df = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = triples.length > 0
    ? tokenized.reduce((s, t) => s + t.length, 0) / triples.length
    : 0;

  cache = { tripleCount: triples.length, tokenized, df, avgdl, aliasIndex: buildAliasIndex(triples) };
  cacheTriples = triples;
  return cache;
}

/** Invalidate the token cache (call after KB reload) */
export function invalidateCache(): void {
  cache = null;
  cacheTriples = null;
}

export type SearchOptions = {
  /**
   * Index each triple under its subject's skos:altLabel values (default true). Set false to
   * measure what search does WITHOUT the thesaurus — the benchmark's control arm.
   */
  expandAliases?: boolean;
  /** Override {@link ALIAS_TERM_WEIGHT}; the benchmark sweeps this. */
  aliasWeight?: number;
};

export function bm25Search(
  triples: Triple[],
  query: string,
  limit = 10,
  options: SearchOptions = {},
): SearchResult[] {
  const N = triples.length;
  if (N === 0) return [];

  const expandAliases = options.expandAliases ?? true;
  const aliasWeight = options.aliasWeight ?? ALIAS_TERM_WEIGHT;
  const { tokenized, df, avgdl, aliasIndex } = getTokenCache(triples);
  const qTokens = tokenize(query);
  const scores = new Float64Array(N);

  const idfOf = (token: string): number => {
    // Clamp df at 1: a term the corpus never uses is maximally discriminating, but the raw
    // formula at df=0 returns a value large enough to swamp every real match.
    const dft = Math.max(df.get(token) ?? 0, 1);
    return Math.log((N - dft + 0.5) / (dft + 0.5) + 1);
  };

  for (const qt of qTokens) {
    const dft = df.get(qt) ?? 0;
    if (dft === 0) continue;
    const idf = idfOf(qt);
    for (let i = 0; i < N; i++) {
      const tokens = tokenized[i];
      const tf = tokens.filter(t => t === qt).length;
      if (tf === 0) continue;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * tokens.length / avgdl));
      scores[i] += idf * norm;
    }
  }

  // ── Alias bonus ───────────────────────────────────────────────────────────
  //
  // Applied AFTER scoring and never to the index, so every score above is exactly what the
  // query would have produced with no thesaurus at all. For each entity whose alias the query
  // covers, every triple of that entity gains the idf mass of the covered terms, scaled by
  // coverage and by aliasWeight. At weight 1 and full coverage that is worth precisely as much
  // as the entity's own text having contained those terms once at average document length —
  // (K1+1)/(1+K1) is 1 — so the weight reads directly as "a synonym is worth this fraction of
  // saying it outright".
  const matchedAliasBySubject = new Map<string, { bonus: number; aliases: string[] }>();
  if (expandAliases && qTokens.length > 0) {
    const qTokenSet = new Set(qTokens);
    for (const [subject, aliases] of aliasIndex) {
      let best = 0;
      const hit: string[] = [];
      for (const alias of aliases) {
        const aTokens = tokenize(alias);
        if (aTokens.length === 0) continue;
        const covered = aTokens.filter(t => qTokenSet.has(t));
        const coverage = covered.length / aTokens.length;
        const mass = covered.reduce((sum, t) => sum + idfOf(t), 0);
        const bonus = aliasWeight * coverage * mass;
        if (bonus > best) best = bonus;
        hit.push(alias);
      }
      if (best > 0) matchedAliasBySubject.set(subject, { bonus: best, aliases: hit });
    }
    if (matchedAliasBySubject.size > 0) {
      for (let i = 0; i < N; i++) {
        const m = matchedAliasBySubject.get(triples[i].subject);
        if (m) scores[i] += m.bonus;
      }
    }
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < N; i++) {
    if (scores[i] > 0) results.push({ triple: triples[i], score: scores[i] });
  }

  // Attribution. A row is credited to an alias only when the alias is why it surfaced — if the
  // triple's own text already carried the query terms, it needed no help and says so by
  // reporting nothing. kb:node-synonyms: unexplained recall is worse than silence, because it
  // looks like it worked.
  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r, i) => {
      const m = matchedAliasBySubject.get(r.triple.subject);
      if (!m) return r;
      const own = new Set(tokenize(tripleText(r.triple)));
      const earned = m.aliases.filter(a =>
        tokenize(a).some(t => qTokens.includes(t) && !own.has(t)),
      );
      return earned.length > 0 ? { ...r, matchedAliases: earned } : r;
    });
}
