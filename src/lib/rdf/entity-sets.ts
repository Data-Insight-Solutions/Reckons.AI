/**
 * Entity sets — a user-defined GROUP of entities (a "set"), alongside entity
 * types (F65). Where a type describes one node's kind, a set is a reusable
 * grouping of several nodes and the relationships among them.
 *
 * First cut: batch multi-select in the graph → "group as set" creates a set
 * node (rdf:type ktype:EntitySet) that links to each member via
 * urn:kbase:predicate/has-member. It's a first-class node, so it round-trips in
 * TTL, is queryable, and can be re-selected to act on the whole group. We call
 * these "sets" throughout the app.
 */
import { v4 as uuid } from 'uuid';
import type { Statement } from './types';

export const ENTITY_SET_TYPE = 'urn:kbase:type/EntitySet';
export const HAS_MEMBER = 'urn:kbase:predicate/has-member';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/**
 * Build the statements for a new set named `name` grouping `memberIris`.
 * Returns the new set's IRI and the statements to add (type + label + members).
 */
export function buildEntitySet(name: string, memberIris: string[]): { setIri: string; statements: Statement[] } {
  const setIri = `urn:kbase:concept/set-${uuid()}`;
  const now = Date.now();
  const common = {
    g: { kind: 'iri' as const, value: 'urn:kbase:source/manual' },
    sourceId: 'manual',
    confidence: 1.0,
    status: 'confirmed' as const,
    createdAt: now,
    updatedAt: now,
  };
  const s = { kind: 'iri' as const, value: setIri };

  const statements: Statement[] = [
    { id: uuid(), s, p: { kind: 'iri', value: RDF_TYPE }, o: { kind: 'iri', value: ENTITY_SET_TYPE }, ...common },
    { id: uuid(), s, p: { kind: 'iri', value: RDFS_LABEL }, o: { kind: 'literal', value: name }, ...common },
    ...memberIris.map((m) => ({
      id: uuid(),
      s,
      p: { kind: 'iri' as const, value: HAS_MEMBER },
      o: { kind: 'iri' as const, value: m },
      ...common,
    })),
  ];
  return { setIri, statements };
}

/** The member IRIs of the set `setIri`. */
export function setMembers(setIri: string, statements: Statement[]): string[] {
  return statements
    .filter((st) => st.s.kind === 'iri' && st.s.value === setIri && st.p.value === HAS_MEMBER && st.o.kind === 'iri' && isActive(st))
    .map((st) => st.o.value);
}

/** True when `iri` is an entity set. */
export function isEntitySet(iri: string, statements: Statement[]): boolean {
  return statements.some(
    (st) => st.s.kind === 'iri' && st.s.value === iri && st.p.value === RDF_TYPE && st.o.kind === 'iri' && st.o.value === ENTITY_SET_TYPE && isActive(st)
  );
}

/** How many members `iri` groups (0 if it isn't a set / has no members). */
export function setMemberCount(iri: string, statements: Statement[]): number {
  return setMembers(iri, statements).length;
}

/** A friendly default set name from member labels (labelFor resolves a node's label). */
export function defaultSetName(memberIris: string[], labelFor: (iri: string) => string): string {
  const labels = memberIris.map(labelFor).filter(Boolean);
  if (labels.length === 0) return 'New set';
  if (labels.length <= 2) return `${labels.join(' & ')} set`;
  return `${labels.slice(0, 2).join(', ')} +${labels.length - 2} set`;
}
