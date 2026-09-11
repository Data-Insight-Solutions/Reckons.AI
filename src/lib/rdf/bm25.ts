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
};

export type BM25Result = {
  id: string;
  score: number;
  doc: BM25Doc;
};

const K1 = 1.5;
const B  = 0.75;

/*
 * STRUCTURAL ROWS DO NOT COMPETE WITH FACTS — see mcp-server/src/search.ts for the measurement
 * and the reasoning. Duplicated here for the same reason the algorithm is: this module must not
 * pull the server into the browser bundle. The two weights must stay in step; if one changes,
 * `set-complexity` re-measures both.
 */
const MEMBERSHIP_PREDICATES = new Set([
  'http://www.w3.org/2004/02/skos/core#member',
  'urn:kbase:predicate/has-member',
  'member',
  'has-member',
]);
const ORDER_PREDICATES = new Set([
  'urn:kbase:predicate/member-order',
  'urn:kbase:predicate/in-set',
  'urn:kbase:predicate/member-entity',
  'member-order',
  'in-set',
  'member-entity',
]);

/**
 * A multiplier on a row's BM25 score, by what KIND of row it is. 1.0 for an ordinary fact.
 *
 * Accepts a bare local name as well as a full IRI, because BM25Doc.predicate is whatever the
 * caller put there and both spellings are in use.
 */
export function structuralWeight(predicate: string): number {
  if (ORDER_PREDICATES.has(predicate)) return 0.1;
  if (MEMBERSHIP_PREDICATES.has(predicate)) return 0.2;
  return 1;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function docText(doc: BM25Doc): string {
  return [doc.subject, doc.predicate, doc.object, doc.sourceTitle ?? ''].join(' ');
}

export class BM25Index {
  private docs: BM25Doc[];
  private tokenizedDocs: string[][];
  private df: Map<string, number>;   // document frequency
  private avgdl: number;
  private N: number;

  constructor(docs: BM25Doc[]) {
    this.docs = docs;
    this.N = docs.length;
    this.tokenizedDocs = docs.map(d => tokenize(docText(d)));

    // Compute document frequencies
    this.df = new Map();
    for (const tokens of this.tokenizedDocs) {
      for (const t of new Set(tokens)) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }

    const totalLen = this.tokenizedDocs.reduce((s, t) => s + t.length, 0);
    this.avgdl = this.N > 0 ? totalLen / this.N : 1;
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

    const results: BM25Result[] = [];
    for (let i = 0; i < this.N; i++) {
      if (scores[i] > 0) {
        const doc = this.docs[i];
        results.push({ id: doc.id, score: scores[i] * structuralWeight(doc.predicate), doc });
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
