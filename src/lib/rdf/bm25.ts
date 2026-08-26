/**
 * BM25 full-text search over RDF statements.
 *
 * Used by:
 *  - MCP server `kb_search` tool
 *  - Future in-app search panel
 *
 * Each statement is represented as a "document" formed from its
 * subject label + predicate + object value + source title.
 * The index is built on demand and is cheap to rebuild (pure JS, no WASM).
 *
 * BM25 parameters: k1=1.5, b=0.75 (standard defaults).
 */

export type BM25Doc = {
  id: string;       // statement id
  subject: string;
  predicate: string;
  object: string;
  sourceTitle?: string;
  confidence?: number;
  /**
   * Other names this document's SUBJECT answers to (skos:altLabel). Indexed alongside the
   * document's own text so a fact recorded under one name is reachable by every other name
   * the entity has — the vocabulary half of F104. See mcp-server/src/search.ts for the same
   * expansion on the server side, and buildAliasDocs() below for deriving these.
   */
  aliases?: string[];
};

export type BM25Result = {
  id: string;
  score: number;
  doc: BM25Doc;
  /** Aliases of the subject that this query hit. Absent when the doc matched on its own text. */
  matchedAliases?: string[];
};

const K1 = 1.5;
const B  = 0.75;

/**
 * How strongly a matched alias boosts a document, relative to its own text having contained
 * the same query terms once.
 *
 * Kept identical to mcp-server/src/search.ts so the in-app index and kb_search rank the same
 * corpus the same way. The bonus is applied AFTER BM25 and never to the index, so a query that
 * worked before scores identically after — see that file for the two measured failures of the
 * index-expansion design this replaced (length penalty, and idf dilution). Swept by
 * tests/bench/run-synonym-search-bench.ts; 0.4 is the knee, 0.6 the conservative default.
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

/** The document's own text. Aliases are scored separately and never indexed. */
function docText(doc: BM25Doc): string {
  return [doc.subject, doc.predicate, doc.object, doc.sourceTitle ?? ''].join(' ');
}

export class BM25Index {
  private docs: BM25Doc[];
  private tokenizedDocs: string[][];
  private df: Map<string, number>;   // document frequency
  private avgdl: number;
  private N: number;
  private aliasWeight: number;

  constructor(docs: BM25Doc[], aliasWeight: number = ALIAS_TERM_WEIGHT) {
    this.docs = docs;
    this.N = docs.length;
    this.aliasWeight = aliasWeight;
    this.tokenizedDocs = docs.map(d => tokenize(docText(d)));

    this.df = new Map();
    for (const tokens of this.tokenizedDocs) {
      for (const t of new Set(tokens)) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }

    const totalLen = this.tokenizedDocs.reduce((s, t) => s + t.length, 0);
    this.avgdl = this.N > 0 ? totalLen / this.N : 1;
  }

  private idfOf(token: string): number {
    // Clamp df at 1: a term the corpus never uses is maximally discriminating, but the raw
    // formula at df=0 returns a value large enough to swamp every real match.
    const dft = Math.max(this.df.get(token) ?? 0, 1);
    return Math.log((this.N - dft + 0.5) / (dft + 0.5) + 1);
  }

  search(query: string, limit = 10): BM25Result[] {
    if (this.N === 0) return [];
    const qTokens = tokenize(query);
    const scores = new Float64Array(this.N);

    for (const qt of qTokens) {
      const df = this.df.get(qt) ?? 0;
      if (df === 0) continue;
      const idf = Math.log((this.N - df + 0.5) / (df + 0.5) + 1);

      for (let i = 0; i < this.N; i++) {
        const tokens = this.tokenizedDocs[i];
        const tf = tokens.filter(t => t === qt).length;
        if (tf === 0) continue;
        const dl = tokens.length;
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * dl / this.avgdl));
        scores[i] += idf * norm;
      }
    }

    // ── Alias bonus ────────────────────────────────────────────────────────
    // Applied after scoring and never to the index, so every score above is exactly what the
    // query would have produced with no thesaurus. At weight 1 and full coverage the bonus
    // equals the document's own text having contained the query terms once at average length.
    if (this.aliasWeight > 0) {
      const qSet = new Set(qTokens);
      for (let i = 0; i < this.N; i++) {
        const aliases = this.docs[i].aliases;
        if (!aliases?.length) continue;
        let best = 0;
        for (const alias of aliases) {
          const at = tokenize(alias);
          if (at.length === 0) continue;
          const covered = at.filter((t) => qSet.has(t));
          const coverage = covered.length / at.length;
            const mass = covered.reduce((sum, t) => sum + this.idfOf(t), 0);
          best = Math.max(best, this.aliasWeight * coverage * mass);
        }
        scores[i] += best;
      }
    }

    const results: BM25Result[] = [];
    for (let i = 0; i < this.N; i++) {
      if (scores[i] > 0) results.push({ id: this.docs[i].id, score: scores[i], doc: this.docs[i] });
    }

    // Attribution, computed only for the rows we return: which alias did the query hit that
    // the document's own text did not already carry? A result with none matched plainly.
    const qTokenSet = new Set(qTokens);
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((r) => {
        const aliases = r.doc.aliases;
        if (!aliases?.length) return r;
        const own = new Set(tokenize(docText(r.doc)));
        const hits = aliases.filter((a) => {
          const at = tokenize(a);
          if (at.length === 0) return false;
          return at.some((tok) => qTokenSet.has(tok) && !own.has(tok));
        });
        return hits.length > 0 ? { ...r, matchedAliases: hits } : r;
      });
  }
}
