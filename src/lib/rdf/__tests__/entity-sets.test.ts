import { describe, it, expect } from 'vitest';
import { buildEntitySet, setMembers, isEntitySet, setMemberCount, defaultSetName, ENTITY_SET_TYPE, HAS_MEMBER, COLLECTION, MEMBER, PREF_LABEL } from '../entity-sets';
import { readSets } from '../sets';
import type { Statement } from '../types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

describe('entity sets', () => {
  it('builds a set node with type, label, and member links', () => {
    const { setIri, statements } = buildEntitySet('Trip crew', ['urn:kbase:concept/alex', 'urn:kbase:concept/jordan']);
    expect(setIri).toMatch(/^urn:kbase:concept\/set-/);

    const typeStmt = statements.find((s) => s.p.value === RDF_TYPE);
    expect(typeStmt?.o).toMatchObject({ kind: 'iri', value: COLLECTION });

    // rdfs:label is emitted BESIDE skos:prefLabel — every label reader in the app wants the former.
    const prefLabel = statements.find((s) => s.p.value === PREF_LABEL);
    expect(prefLabel?.o).toMatchObject({ value: 'Trip crew' });
    const label = statements.find((s) => s.p.value.endsWith('rdf-schema#label'));
    expect(label?.o).toMatchObject({ value: 'Trip crew' });

    const members = statements.filter((s) => s.p.value === MEMBER);
    expect(members).toHaveLength(2);
    expect(members.every((s) => s.s.value === setIri && s.status === 'confirmed')).toBe(true);
  });

  it('reads members and membership back', () => {
    const { setIri, statements } = buildEntitySet('S', ['a', 'b', 'c']);
    expect(setMembers(setIri, statements).sort()).toEqual(['a', 'b', 'c']);
    expect(setMemberCount(setIri, statements)).toBe(3);
    expect(isEntitySet(setIri, statements)).toBe(true);
    expect(isEntitySet('a', statements)).toBe(false);
  });

  it('ignores rejected member links', () => {
    const { setIri, statements } = buildEntitySet('S', ['a', 'b']);
    const withRejected = statements.map((s) =>
      s.p.value === MEMBER && s.o.kind === 'iri' && s.o.value === 'b' ? { ...s, status: 'rejected' as const } : s
    );
    expect(setMembers(setIri, withRejected)).toEqual(['a']);
  });

  /*
   * THE REGRESSION THAT PROMPTED THE MERGE (2026-09-11). Two grouping vocabularies existed and
   * neither knew about the other, so every set made in the app was invisible to the sets layer
   * that composes pages. Each half passed its own tests; only a test that crosses the seam fails.
   */
  it('reads a set written in the LEGACY F65 dialect', () => {
    const legacy: Statement[] = [
      { id: '1', s: { kind: 'iri', value: 'set-x' }, p: { kind: 'iri', value: RDF_TYPE }, o: { kind: 'iri', value: ENTITY_SET_TYPE },
        g: { kind: 'iri', value: 'g' }, sourceId: 'g', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0 },
      { id: '2', s: { kind: 'iri', value: 'set-x' }, p: { kind: 'iri', value: HAS_MEMBER }, o: { kind: 'iri', value: 'a' },
        g: { kind: 'iri', value: 'g' }, sourceId: 'g', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0 },
    ];
    expect(isEntitySet('set-x', legacy)).toBe(true);
    expect(setMembers('set-x', legacy)).toEqual(['a']);
  });

  it('a set built here is VISIBLE to the F187 reader that composes pages', () => {
    const { setIri, statements } = buildEntitySet('Trip crew', ['a', 'b']);
    const quads = statements.map((st) => ({
      subject: { value: st.s.value }, predicate: { value: st.p.value }, object: { value: st.o.value },
    }));
    const [set] = readSets(quads);
    expect(set.iri).toBe(setIri);
    expect(set.label).toBe('Trip crew');
    expect(set.members.map((m) => m.iri).sort()).toEqual(['a', 'b']);
  });

  it('defaultSetName reads from member labels', () => {
    const labelFor = (iri: string) => ({ a: 'Alex', b: 'Jordan', c: 'Sam', d: 'Kim' }[iri] ?? iri);
    expect(defaultSetName(['a', 'b'], labelFor)).toBe('Alex & Jordan set');
    expect(defaultSetName(['a', 'b', 'c', 'd'], labelFor)).toBe('Alex, Jordan +2 set');
    expect(defaultSetName([], labelFor)).toBe('New set');
  });
});
