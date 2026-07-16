/**
 * Roles (F84 descriptive layer) — customizable "who", NOT access control.
 *
 * Two things must hold or the feature is either useless or dishonest: (1) custom roles declared
 * in the graph are discovered and travel with it, exactly like custom entity types; (2) a person's
 * assigned roles resolve to their labels. The moment a test in here starts asserting that a role
 * BLOCKS or GRANTS something, that is the signal RBAC has leaked into the descriptive layer — it
 * belongs to the backend tier, and this file is the tripwire.
 */
import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ROLES,
  labelToRoleIri,
  parseCustomRoles,
  buildRoleMap,
  rolesForEntity,
  HAS_ROLE,
  RDF_TYPE,
  RDFS_LABEL,
  KB_ROLE_TYPE,
  ROLE_PREFIX,
} from '../roles';

const t = (subject: string, predicate: string, object: string) => ({ subject, predicate, object });

describe('labelToRoleIri', () => {
  it('slugs a label into a role IRI', () => {
    expect(labelToRoleIri('Technical Solutions Architect')).toBe(ROLE_PREFIX + 'technical-solutions-architect');
    expect(labelToRoleIri('  Owner / Operator  ')).toBe(ROLE_PREFIX + 'owner-operator');
  });
});

describe('parseCustomRoles', () => {
  it('finds roles declared as rdf:type Role and reads their labels', () => {
    const stmts = [
      t('urn:kbase:role/founder', RDF_TYPE, KB_ROLE_TYPE),
      t('urn:kbase:role/founder', RDFS_LABEL, 'Founder'),
      t('urn:kbase:concept/x', RDF_TYPE, 'urn:kbase:type/EntityType'), // not a role
    ];
    const roles = parseCustomRoles(stmts);
    expect(roles).toEqual([{ iri: 'urn:kbase:role/founder', label: 'Founder', description: '', builtIn: false }]);
  });
});

describe('buildRoleMap', () => {
  it('includes every built-in plus custom roles', () => {
    const map = buildRoleMap([{ iri: 'urn:kbase:role/founder', label: 'Founder', description: '', builtIn: false }]);
    expect(map.size).toBe(BUILT_IN_ROLES.length + 1);
    expect(map.get(ROLE_PREFIX + 'owner-operator')?.label).toBe('Owner Operator');
    expect(map.get('urn:kbase:role/founder')?.label).toBe('Founder');
  });
});

describe('rolesForEntity', () => {
  it("resolves a person's assigned roles to their labels", () => {
    const stmts = [
      t('urn:kbase:concept/matthew-roe', HAS_ROLE, ROLE_PREFIX + 'owner-operator'),
      t('urn:kbase:concept/matthew-roe', HAS_ROLE, ROLE_PREFIX + 'technical-solutions-architect'),
      t('urn:kbase:concept/someone-else', HAS_ROLE, ROLE_PREFIX + 'reviewer'),
    ];
    const labels = rolesForEntity('urn:kbase:concept/matthew-roe', stmts).map((r) => r.label);
    expect(labels).toEqual(['Owner Operator', 'Technical Solutions Architect']);
  });

  it('falls back to a slugged label for an unknown/custom role IRI', () => {
    const stmts = [t('urn:p', HAS_ROLE, ROLE_PREFIX + 'wildcard')];
    expect(rolesForEntity('urn:p', stmts)[0]).toMatchObject({ label: 'wildcard', builtIn: false });
  });

  it('picks up a custom role declared in the same graph', () => {
    const stmts = [
      t('urn:kbase:role/founder', RDF_TYPE, KB_ROLE_TYPE),
      t('urn:kbase:role/founder', RDFS_LABEL, 'Founder'),
      t('urn:p', HAS_ROLE, 'urn:kbase:role/founder'),
    ];
    expect(rolesForEntity('urn:p', stmts).map((r) => r.label)).toEqual(['Founder']);
  });
});
