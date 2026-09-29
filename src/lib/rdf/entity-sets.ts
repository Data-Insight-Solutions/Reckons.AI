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

/*
 * WRITES SKOS, READS BOTH (2026-09-11).
 *
 * This module shipped `ktype:EntitySet` + `kpred:has-member`; F187's src/lib/rdf/sets.ts chose
 * `skos:Collection` + `skos:member`. Both were internally consistent, so nothing failed — sets made
 * here were simply INVISIBLE to the sets layer that composes pages and to `set-integrity`.
 *
 * One vocabulary now, and it is the standard one, because the alternative is teaching every future
 * reader two dialects. The legacy terms are still READ (graphs in the wild, and the two that ship
 * in static/) and still EXPORTED as constants so existing importers keep compiling.
 */
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const COLLECTION = `${SKOS}Collection`;
export const MEMBER = `${SKOS}member`;
export const PREF_LABEL = `${SKOS}prefLabel`;
/** F65's spelling. Read, never written. */
export const ENTITY_SET_TYPE = 'urn:kbase:type/EntitySet';
/** F65's spelling. Read, never written. */
export const HAS_MEMBER = 'urn:kbase:predicate/has-member';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** True for either spelling of "groups entities". */
function isMembership(predicate: string): boolean {
  return predicate === MEMBER || predicate === HAS_MEMBER;
}

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

  /*
   * rdfs:label is emitted BESIDE skos:prefLabel, not instead of it. Every label reader in the app
   * (the canvas, search, the node panel) looks for rdfs:label; dropping it to be tidy would make a
   * new set render as a bare IRI. One extra triple per set, paid once, against a visible regression.
   */
  const statements: Statement[] = [
    { id: uuid(), s, p: { kind: 'iri', value: RDF_TYPE }, o: { kind: 'iri', value: COLLECTION }, ...common },
    { id: uuid(), s, p: { kind: 'iri', value: PREF_LABEL }, o: { kind: 'literal', value: name }, ...common },
    { id: uuid(), s, p: { kind: 'iri', value: RDFS_LABEL }, o: { kind: 'literal', value: name }, ...common },
    ...memberIris.map((m) => ({
      id: uuid(),
      s,
      p: { kind: 'iri' as const, value: MEMBER },
      o: { kind: 'iri' as const, value: m },
      ...common,
    })),
  ];
  return { setIri, statements };
}

/** The member IRIs of the set `setIri`. */
export function setMembers(setIri: string, statements: Statement[]): string[] {
  return statements
    .filter((st) => st.s.kind === 'iri' && st.s.value === setIri && isMembership(st.p.value) && st.o.kind === 'iri' && isActive(st))
    .map((st) => st.o.value);
}

/** True when `iri` is an entity set. */
export function isEntitySet(iri: string, statements: Statement[]): boolean {
  return statements.some(
    (st) => st.s.kind === 'iri' && st.s.value === iri && st.p.value === RDF_TYPE && st.o.kind === 'iri'
      && (st.o.value === COLLECTION || st.o.value === ENTITY_SET_TYPE) && isActive(st)
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
