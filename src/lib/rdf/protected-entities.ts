/**
 * "Protected" entities — nodes whose deletion would break features, so the UI
 * asks for confirmation before removing them (instead of deleting silently).
 *
 * Three structural cases:
 *   1. A TYPE that other nodes instantiate (`rdf:type <iri>`) — deleting it
 *      un-types every one of those nodes.
 *   2. An entity-TYPE DEFINITION (`rdf:type urn:kbase:type/EntityType`) — the
 *      thing that gives a type its icon/color/label.
 *   3. A NAVIGATION / LEAP node (a `urn:reckons:leap` source/target, or a node
 *      carrying `urn:reckons:nav/…` ordering) — deleting it breaks graph
 *      navigation between KBs / sections.
 */
import type { Statement } from './types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const ENTITY_TYPE = 'urn:kbase:type/EntityType';
const LEAP_PRED = 'urn:reckons:leap';
const NAV_NS = 'urn:reckons:nav/';

export type EntityProtection = { protected: boolean; reason?: string };

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/**
 * Assess whether deleting `iri` would break features. Returns `{ protected }`
 * and, when protected, a short human `reason` for the confirmation prompt.
 */
export function entityProtection(iri: string, statements: Statement[]): EntityProtection {
  let typedByCount = 0;
  let isEntityType = false;
  let isNavOrLeap = false;

  for (const s of statements) {
    if (!isActive(s)) continue;

    // Other nodes typed AS this entity → it's a type in use.
    if (s.p.value === RDF_TYPE && s.o.kind === 'iri' && s.o.value === iri && s.s.value !== iri) {
      typedByCount++;
    }
    // This entity declared as an EntityType definition.
    if (s.s.kind === 'iri' && s.s.value === iri && s.p.value === RDF_TYPE && s.o.kind === 'iri' && s.o.value === ENTITY_TYPE) {
      isEntityType = true;
    }
    // Leap source / nav-structured node …
    if (s.s.kind === 'iri' && s.s.value === iri && (s.p.value === LEAP_PRED || s.p.value.startsWith(NAV_NS))) {
      isNavOrLeap = true;
    }
    // … or a leap target.
    if (s.p.value === LEAP_PRED && s.o.kind === 'iri' && s.o.value === iri) {
      isNavOrLeap = true;
    }
  }

  if (typedByCount > 0) {
    const plural = typedByCount !== 1;
    return {
      protected: true,
      reason: `${typedByCount} node${plural ? 's are' : ' is'} typed as this — deleting it will un-type ${plural ? 'them' : 'it'}.`,
    };
  }
  if (isEntityType) {
    return { protected: true, reason: 'This is an entity-type definition — deleting it removes the type (icon, colour, label).' };
  }
  if (isNavOrLeap) {
    return { protected: true, reason: 'This is a navigation / leap node — deleting it can break graph navigation.' };
  }
  return { protected: false };
}
