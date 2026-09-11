/**
 * BM25 search over triples — same algorithm as src/lib/retrieval/bm25.ts
 * duplicated here so the MCP server has no dependency on the browser bundle.
 *
 * Caches tokenization so repeated searches against the same triple set
 * don't re-tokenize on every call.
 */

import type { Triple } from './kb-reader.js';

const K1 = 1.5;
const B  = 0.75;

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

export type SearchResult = { triple: Triple; score: number };

/*
 * STRUCTURAL ROWS DO NOT COMPETE WITH FACTS (2026-09-11).
 *
 * MEASURED, not suspected — scripts/offline/set-complexity.ts over the 17,098-quad corpus:
 * 11 of 25 member-name queries returned a membership row in the top 10, and 5 of 25 had a REAL
 * result pushed out of the top 10 to make room. That is 20% of queries made measurably worse by
 * grouping, and it is the whole of what sets cost search.
 *
 * The cause is that BM25 here makes one document per statement, so `shortlist skos:member aprimo`
 * is a document that scores on "aprimo" while saying nothing whatever about Aprimo. The member's
 * name is already indexed on every real fact about it; the membership row adds a duplicate of the
 * name and no information.
 *
 * DOWNWEIGHTED RATHER THAN DROPPED, deliberately. Dropping membership would make "what is in the
 * shortlist" unanswerable by search, which is a worse failure than crowding. A weight keeps the
 * row findable when it is the best answer available and stops it outranking a fact when it is not.
 *
 * The order machinery is weighted lower again because it is not weak information, it is none:
 * `<set>/member/aprimo kpred:member-order 3` exists to carry an integer and its text is an
 * accident of the skolemised IRI.
 *
 * 0.2 IS THE KNEE, NOT A GUESS AND NOT A FLOOR. Swept over the same 25 queries:
 *
 *     weight   0.5    0.3    0.2    0.15   0.05
 *     crowded   9      8      7      7      7
 *     displaced 3      2      1      1      1
 *
 * Everything below 0.2 buys nothing and costs something — it pushes membership further down for
 * the queries where a membership row IS the best answer. Stopping at the plateau rather than at
 * zero is the difference between fixing the measured problem and fitting 25 queries.
 *
 * ONE DISPLACEMENT SURVIVES ("Reckoning") and weighting cannot remove it: that row is genuinely
 * the strongest lexical match for the query. Reported rather than tuned away.
 */
const MEMBERSHIP_PREDICATES = new Set([
  'http://www.w3.org/2004/02/skos/core#member',
  'urn:kbase:predicate/has-member',
]);
const ORDER_PREDICATES = new Set([
  'urn:kbase:predicate/member-order',
  'urn:kbase:predicate/in-set',
  'urn:kbase:predicate/member-entity',
]);
const MEMBERSHIP_WEIGHT = 0.2;
const ORDER_WEIGHT = 0.1;

/** A multiplier on a row's BM25 score, by what KIND of row it is. 1.0 for an ordinary fact. */
export function structuralWeight(predicate: string): number {
  if (ORDER_PREDICATES.has(predicate)) return ORDER_WEIGHT;
  if (MEMBERSHIP_PREDICATES.has(predicate)) return MEMBERSHIP_WEIGHT;
  return 1;
}

// ── Tokenization cache ──────────────────────────────────────────────────────

type TokenCache = {
  tripleCount: number;
  tokenized: string[][];
  df: Map<string, number>;
  avgdl: number;
};

let cache: TokenCache | null = null;
let cacheTriples: Triple[] | null = null;

function getTokenCache(triples: Triple[]): TokenCache {
  // Invalidate if triple array identity or length changed
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

  cache = { tripleCount: triples.length, tokenized, df, avgdl };
  cacheTriples = triples;
  return cache;
}

/** Invalidate the token cache (call after KB reload) */
export function invalidateCache(): void {
  cache = null;
  cacheTriples = null;
}

export function bm25Search(triples: Triple[], query: string, limit = 10): SearchResult[] {
  const N = triples.length;
  if (N === 0) return [];

  const { tokenized, df, avgdl } = getTokenCache(triples);
  const qTokens = tokenize(query);
  const scores = new Float64Array(N);

  for (const qt of qTokens) {
    const dft = df.get(qt) ?? 0;
    if (dft === 0) continue;
    const idf = Math.log((N - dft + 0.5) / (dft + 0.5) + 1);
    for (let i = 0; i < N; i++) {
      const tokens = tokenized[i];
      const tf = tokens.filter(t => t === qt).length;
      if (tf === 0) continue;
      const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * tokens.length / avgdl));
      scores[i] += idf * norm;
    }
  }

  const results: SearchResult[] = [];
  for (let i = 0; i < N; i++) {
    if (scores[i] > 0) {
      results.push({ triple: triples[i], score: scores[i] * structuralWeight(triples[i].predicate) });
    }
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
