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
    if (scores[i] > 0) results.push({ triple: triples[i], score: scores[i] });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
