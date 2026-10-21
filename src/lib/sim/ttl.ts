// F260.1 — Turtle to Statement[] for headless use (CLI, tests). Not imported by the app bundle.
import { Parser } from 'n3';
import type { Statement } from '../rdf/types';

export function statementsFromTtl(ttl: string): Statement[] {
  const quads = new Parser({ format: 'Turtle' }).parse(ttl);
  return quads.map((q: import('@rdfjs/types').Quad, i: number) => ({
    id: `ttl-${i}`,
    s: q.subject.termType === 'BlankNode' ? { kind: 'bnode', value: q.subject.value } : { kind: 'iri', value: q.subject.value },
    p: { kind: 'iri', value: q.predicate.value },
    o: q.object.termType === 'Literal' ? { kind: 'literal', value: q.object.value }
      : q.object.termType === 'BlankNode' ? { kind: 'bnode', value: q.object.value } : { kind: 'iri', value: q.object.value },
    g: { kind: 'iri', value: 'urn:kbase:graph/default' },
    sourceId: 'ttl', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
  })) as unknown as Statement[];
}
