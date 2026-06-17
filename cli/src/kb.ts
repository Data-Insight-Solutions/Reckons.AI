/**
 * KB reader — loads a .ttl file into queryable in-memory triples.
 * Adapted from mcp-server/src/kb-reader.ts with BM25 search built in.
 */

import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { Store, StreamParser, type Quad } from 'n3';

// ── Types ────────────────────────────────────────────────────────────────────

export type Triple = {
  subject: string;
  predicate: string;
  object: string;
  objectIsLiteral: boolean;
  graph?: string;
  sourceId?: string;
};

export type KBStats = {
  tripleCount: number;
  sourceCount: number;
  entityCount: number;
  typeCount: number;
  lastModified: Date;
};

// ── KB Reader ────────────────────────────────────────────────────────────────

export class KBReader {
  private store = new Store();
  private lastMtime = 0;
  readonly path: string;

  constructor(ttlPath: string) {
    this.path = resolve(ttlPath);
    this.reload();
  }

  reload(): boolean {
    if (!existsSync(this.path)) return false;
    const stat = statSync(this.path);
    if (stat.mtimeMs === this.lastMtime) return false;
    this.lastMtime = stat.mtimeMs;

    const text = readFileSync(this.path, 'utf8');
    // Use streaming parser — more robust with varied Turtle styles
    const quads: Quad[] = [];
    try {
      const parser = new StreamParser();
      parser.on('data', (quad: Quad) => quads.push(quad));
      // Feed the text synchronously via a Readable
      const readable = Readable.from(text);
      readable.pipe(parser);
      // StreamParser is synchronous for string input once piped
      // but we need to wait for 'end'. Use a simpler approach:
    } catch { /* fall through */ }

    // Simpler synchronous approach: split and feed
    if (quads.length === 0) {
      try {
        const parser = new StreamParser();
        const collected: Quad[] = [];
        let done = false;
        parser.on('data', (q: Quad) => collected.push(q));
        parser.on('end', () => { done = true; });
        parser.on('error', () => { done = true; });
        parser.write(text);
        parser.end();
        // StreamParser processes synchronously for write+end
        if (collected.length > 0) {
          this.store = new Store(collected);
          return true;
        }
      } catch { /* fall through */ }
    }
    if (quads.length > 0) this.store = new Store(quads);
    return quads.length > 0;
  }

  stats(): KBStats {
    const subjects = new Set<string>();
    const graphs = new Set<string>();
    const types = new Set<string>();
    for (const q of this.store) {
      subjects.add(q.subject.value);
      if (q.graph?.value) graphs.add(q.graph.value);
      if (q.predicate.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type') {
        types.add(q.object.value);
      }
    }
    return {
      tripleCount: this.store.size,
      sourceCount: graphs.size,
      entityCount: subjects.size,
      typeCount: types.size,
      lastModified: new Date(this.lastMtime),
    };
  }

  allTriples(): Triple[] {
    const out: Triple[] = [];
    for (const q of this.store) {
      out.push({
        subject: q.subject.value,
        predicate: q.predicate.value,
        object: q.object.value,
        objectIsLiteral: q.object.termType === 'Literal',
        graph: q.graph?.value || undefined,
        sourceId: q.graph?.value?.replace('urn:kbase:source/', '') || undefined,
      });
    }
    return out;
  }

  triplesAbout(iri: string): Triple[] {
    return this.allTriples().filter(t => t.subject === iri || t.object === iri);
  }

  entityIRIs(): string[] {
    const seen = new Set<string>();
    for (const q of this.store) {
      if (q.subject.termType === 'NamedNode') seen.add(q.subject.value);
    }
    return [...seen];
  }

  /** Get label for an entity IRI (rdfs:label value) */
  label(iri: string): string | null {
    for (const q of this.store) {
      if (q.subject.value === iri && q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#label') {
        return q.object.value;
      }
    }
    return null;
  }

  /** Resolve a short label/slug to an entity IRI */
  resolveLabel(label: string): string | null {
    const lower = label.toLowerCase();
    // Try exact rdfs:label match first
    for (const q of this.store) {
      if (q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#label' &&
          q.object.value.toLowerCase() === lower) {
        return q.subject.value;
      }
    }
    // Fallback: slug match
    for (const iri of this.entityIRIs()) {
      const slug = iri.split('/').pop()?.toLowerCase() ?? '';
      if (slug === lower || slug.includes(lower)) return iri;
    }
    return null;
  }
}

// ── BM25 Search ──────────────────────────────────────────────────────────────

const K1 = 1.5;
const B = 0.75;

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s\-_]/g, ' ').split(/\s+/).filter(t => t.length > 1);
}

function tripleText(t: Triple): string {
  const s = t.subject.split('/').pop() ?? t.subject;
  const p = t.predicate.split('/').pop() ?? t.predicate;
  return `${s} ${p} ${t.object}`;
}

export function search(triples: Triple[], query: string, limit = 10): Array<{ triple: Triple; score: number }> {
  const N = triples.length;
  if (N === 0) return [];

  const tokenized = triples.map(t => tokenize(tripleText(t)));
  const df = new Map<string, number>();
  for (const tokens of tokenized) {
    for (const t of new Set(tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = tokenized.reduce((s, t) => s + t.length, 0) / N;
  const qTokens = tokenize(query);
  const scores = new Float64Array(N);

  for (const qt of qTokens) {
    const dft = df.get(qt) ?? 0;
    if (dft === 0) continue;
    const idf = Math.log((N - dft + 0.5) / (dft + 0.5) + 1);
    for (let i = 0; i < N; i++) {
      const tf = tokenized[i].filter(t => t === qt).length;
      if (tf === 0) continue;
      scores[i] += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * tokenized[i].length / avgdl));
    }
  }

  const results: Array<{ triple: Triple; score: number }> = [];
  for (let i = 0; i < N; i++) {
    if (scores[i] > 0) results.push({ triple: triples[i], score: scores[i] });
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}
