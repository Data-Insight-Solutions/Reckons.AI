/**
 * Role system for Reckons.AI — DESCRIPTIVE metadata, not access control.
 *
 * A role says what a person IS to a graph (Owner Operator, Technical Solutions Architect,
 * Reviewer…). It is portable metadata, customizable exactly like entity types: the built-ins
 * live here as static data; CUSTOM roles live as confirmed RDF statements in the graph itself
 * (`<iri> rdf:type urn:kbase:type/Role ; rdfs:label "…"`), so they travel with the graph on
 * export and are versioned like any other fact. A person carries them via `has-role`.
 *
 * WHAT THIS IS NOT: RBAC. A role here grants NOTHING and gates NOTHING. It is the "who" that
 * feeds provenance (F80/F91) and publisher identity (F75 — publishing requires an attributed
 * publisher), so a fact can be tied to a person with a stated relationship to the graph.
 * Enforcement — who MAY read / write / publish — is a separate, deliberately-deferred concern
 * that belongs to the backend-services tier (kb:backend-services / F84). Access control without
 * a trusted server is theatre: client-side "permissions" over an offline, user-owned .ttl file
 * are a suggestion anyone can edit out, not a control (kb:honest-status). Roles ship now; RBAC
 * waits for the server.
 */

export const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
export const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const KB_ROLE_TYPE = 'urn:kbase:type/Role';
export const HAS_ROLE = 'urn:kbase:predicate/has-role';
export const ROLE_PREFIX = 'urn:kbase:role/';

export type RoleDef = {
  iri: string;
  label: string;
  description: string;
  builtIn: boolean;
};

/** Starter roles. Users add their own; these are only defaults, never a fixed set. */
export const BUILT_IN_ROLES: RoleDef[] = [
  { iri: ROLE_PREFIX + 'owner-operator', label: 'Owner Operator', description: 'Runs and is accountable for the graph — the buck stops here.', builtIn: true },
  { iri: ROLE_PREFIX + 'technical-solutions-architect', label: 'Technical Solutions Architect', description: 'Designs the system and its integrations.', builtIn: true },
  { iri: ROLE_PREFIX + 'contributor', label: 'Contributor', description: 'Adds facts and sources to the graph.', builtIn: true },
  { iri: ROLE_PREFIX + 'reviewer', label: 'Reviewer', description: 'Settles pending facts — confirms, refines, rejects.', builtIn: true },
  { iri: ROLE_PREFIX + 'steward', label: 'Steward', description: 'Maintains graph quality, structure, and conventions.', builtIn: true },
  { iri: ROLE_PREFIX + 'publisher', label: 'Publisher', description: 'Attributed party for a published (TriG) graph; publishing requires one (F75).', builtIn: true },
];

/** Slug an arbitrary role label into a valid role IRI. Mirrors entity-types.labelToIri. */
export function labelToRoleIri(label: string): string {
  return (
    ROLE_PREFIX +
    label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  );
}

// A minimal triple shape that both N3 quads and our Statement rows satisfy for reading.
interface TripleLike {
  s?: { value: string };
  p?: { value: string };
  o?: { value: string };
  subject?: string;
  predicate?: string;
  object?: string;
}
const subj = (t: TripleLike) => t.s?.value ?? t.subject ?? '';
const pred = (t: TripleLike) => t.p?.value ?? t.predicate ?? '';
const obj = (t: TripleLike) => t.o?.value ?? t.object ?? '';

/** Custom roles declared in the graph (rdf:type urn:kbase:type/Role, labelled by rdfs:label). */
export function parseCustomRoles(statements: TripleLike[]): RoleDef[] {
  const roleIris = new Set(statements.filter((t) => pred(t) === RDF_TYPE && obj(t) === KB_ROLE_TYPE).map(subj));
  const labels = new Map<string, string>();
  for (const t of statements) if (roleIris.has(subj(t)) && pred(t) === RDFS_LABEL) labels.set(subj(t), obj(t));
  return [...roleIris].map((iri) => ({
    iri,
    label: labels.get(iri) ?? iri.replace(ROLE_PREFIX, ''),
    description: '',
    builtIn: false,
  }));
}

/** Built-ins plus any custom roles, keyed by IRI. Custom labels override built-ins on collision. */
export function buildRoleMap(custom: RoleDef[]): Map<string, RoleDef> {
  const map = new Map<string, RoleDef>();
  for (const r of BUILT_IN_ROLES) map.set(r.iri, r);
  for (const r of custom) map.set(r.iri, r);
  return map;
}

/** The roles assigned to an entity (a person) via has-role, resolved against the role map. */
export function rolesForEntity(
  entity: string,
  statements: TripleLike[],
  roleMap: Map<string, RoleDef> = buildRoleMap(parseCustomRoles(statements)),
): RoleDef[] {
  return statements
    .filter((t) => subj(t) === entity && pred(t) === HAS_ROLE)
    .map((t) => obj(t))
    .map((iri) => roleMap.get(iri) ?? { iri, label: iri.replace(ROLE_PREFIX, ''), description: '', builtIn: false });
}
