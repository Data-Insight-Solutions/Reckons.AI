/**
 * Read a TTL file as Statements, for offline scripts that reason over a graph with the app's own
 * modules (F139).
 *
 * Shared because two scripts already needed the identical shim and a third will. The fields it
 * fabricates are the ones a FILE cannot carry — a statement id, a review status, timestamps — and
 * that is exactly the honest limit to keep in mind when reading these reports: they analyse the
 * graph as WRITTEN, not the review state of a live workspace. Anything that depends on real
 * `status`, `createdAt` or `proposedBy` must read the queue or the app database instead.
 */
import { readFileSync } from 'fs';
import N3 from 'n3';
import type { Statement } from '../../src/lib/rdf/types.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface ReadGraph {
  statements: Statement[];
  /** subject IRI -> rdf:type, so F88 authority reservations resolve. */
  typeOf: (iri: string) => string | undefined;
}

/**
 * `asReviewSet` marks every statement `pending` so a committed file can be inspected AS IF it were
 * a review queue. It must be opt-in and named: buildReviewTree deliberately ignores settled facts,
 * and an earlier version of this tooling defaulted the other way and reported 1,641 outstanding
 * review items on a graph that had none.
 */
export function readGraph(file: string, opts: { asReviewSet?: boolean } = {}): ReadGraph {
  const quads = new N3.Parser().parse(readFileSync(file, 'utf8'));
  const types = new Map<string, string>();
  for (const q of quads) if (q.predicate.value === RDF_TYPE) types.set(q.subject.value, q.object.value);

  const statements = quads.map((q, i) => ({
    id: `${file}#${i}`,
    s: { kind: q.subject.termType === 'Literal' ? 'literal' : 'iri', value: q.subject.value },
    p: { kind: 'iri', value: q.predicate.value },
    o: { kind: q.object.termType === 'Literal' ? 'literal' : 'iri', value: q.object.value },
    g: { kind: 'iri', value: 'urn:kbase:graph/file' },
    sourceId: file,
    confidence: 1,
    // Everything in a committed TTL has already been accepted, so `pending` would be a lie about
    // review state — unless the caller explicitly asks for a review-set read.
    status: opts.asReviewSet ? 'pending' : 'confirmed',
    createdAt: i,
    updatedAt: i,
  })) as unknown as Statement[];

  return { statements, typeOf: (iri: string) => types.get(iri) };
}
