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
      if (scores[i] > 0) results.push({ id: this.docs[i].id, score: scores[i], doc: this.docs[i] });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}
