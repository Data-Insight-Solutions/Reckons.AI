/**
 * KB Reader — parses a Reckons.AI .ttl file into queryable in-memory triples.
 *
 * Reckons.AI exports annotated Turtle with named graphs carrying provenance:
 *   GRAPH <urn:kbase:source/SOURCE_ID> { <s> <p> <o> . }
 *
 * This reader handles both annotated (named graphs) and plain Turtle.
 */

import { readFileSync, statSync, watchFile, type WatchListener } from 'node:fs';
import { resolve } from 'node:path';
import { Store, Parser, DataFactory, type Quad } from 'n3';

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
  lastModified: Date;
};

export class KBReader {
  private ttlPath: string;
  private store: Store = new Store();
  private lastMtime = 0;

  constructor(ttlPath: string) {
    this.ttlPath = resolve(ttlPath);
    this.reload();
  }

  reload(): void {
    try {
      const stat = statSync(this.ttlPath);
      const mtime = stat.mtimeMs;
      if (mtime === this.lastMtime) return;
      this.lastMtime = mtime;

      const text = readFileSync(this.ttlPath, 'utf8');
      const parser = new Parser({ format: 'Turtle*' });
      const quads: Quad[] = [];

      parser.parse(text, (err, quad) => {
        if (err) {
          // Try plain Turtle fallback
          try {
            const p2 = new Parser({ format: 'Turtle' });
            const q2: Quad[] = [];
            p2.parse(text, (e2, q) => { if (q) q2.push(q); });
            this.store = new Store(q2);
          } catch { /* leave existing store */ }
          return;
        }
        if (quad) quads.push(quad);
      });

      if (quads.length > 0) this.store = new Store(quads);
    } catch (e) {
      // File doesn't exist yet or is unreadable — start with empty store
    }
  }

  watch(cb: () => void): void {
    watchFile(this.ttlPath, { interval: 2000 }, () => {
      this.reload();
      cb();
    });
  }

  stats(): KBStats {
    const subjects = new Set<string>();
    const graphs   = new Set<string>();
    for (const q of this.store) {
      subjects.add(q.subject.value);
      if (q.graph?.value) graphs.add(q.graph.value);
    }
    return {
      tripleCount:  this.store.size,
      sourceCount:  graphs.size,
      entityCount:  subjects.size,
      lastModified: new Date(this.lastMtime),
    };
  }

  allTriples(): Triple[] {
    const out: Triple[] = [];
    for (const q of this.store) {
      out.push({
        subject:       q.subject.value,
        predicate:     q.predicate.value,
        object:        q.object.value,
        objectIsLiteral: q.object.termType === 'Literal',
        graph:         q.graph?.value || undefined,
        sourceId:      q.graph?.value?.replace('urn:kbase:source/', '') || undefined,
      });
    }
    return out;
  }

  private quadToTriple(q: Quad): Triple {
    return {
      subject: q.subject.value,
      predicate: q.predicate.value,
      object: q.object.value,
      objectIsLiteral: q.object.termType === 'Literal',
      graph: q.graph?.value || undefined,
      sourceId: q.graph?.value?.replace('urn:kbase:source/', '') || undefined,
    };
  }

  triplesAbout(iri: string): Triple[] {
    const node = DataFactory.namedNode(iri);
    const out: Triple[] = [];
    const seen = new Set<string>();
    const add = (q: Quad) => {
      const key = `${q.subject.value}\t${q.predicate.value}\t${q.object.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(this.quadToTriple(q));
    };
    for (const q of this.store.getQuads(node, null, null, null)) add(q);
    for (const q of this.store.getQuads(null, null, node, null)) add(q);
    return out;
  }

  /** Get triples in the N-hop neighborhood of an entity */
  subgraph(iri: string, hops = 1): Triple[] {
    const visited = new Set<string>([iri]);
    let frontier = [iri];
    const out: Triple[] = [];
    const seen = new Set<string>();

    for (let h = 0; h < hops; h++) {
      const next: string[] = [];
      for (const entity of frontier) {
        const node = DataFactory.namedNode(entity);
        const add = (q: Quad) => {
          const key = `${q.subject.value}\t${q.predicate.value}\t${q.object.value}`;
          if (seen.has(key)) return;
          seen.add(key);
          out.push(this.quadToTriple(q));
          if (q.object.termType === 'NamedNode' && !visited.has(q.object.value)) {
            visited.add(q.object.value);
            next.push(q.object.value);
          }
          if (!visited.has(q.subject.value)) {
            visited.add(q.subject.value);
            next.push(q.subject.value);
          }
        };
        for (const q of this.store.getQuads(node, null, null, null)) add(q);
        for (const q of this.store.getQuads(null, null, node, null)) add(q);
      }
      frontier = next;
    }
    return out;
  }

  entityIRIs(): string[] {
    const seen = new Set<string>();
    for (const q of this.store) {
      if (q.subject.termType === 'NamedNode') seen.add(q.subject.value);
    }
    return [...seen];
  }

  /** Resolve a short label/slug to an entity IRI (best-effort) */
  resolveLabel(label: string): string | null {
    const lower = label.toLowerCase();
    for (const iri of this.entityIRIs()) {
      const slug = iri.split('/').pop()?.toLowerCase() ?? '';
      if (slug === lower || slug.includes(lower)) return iri;
    }
    return null;
  }
}
