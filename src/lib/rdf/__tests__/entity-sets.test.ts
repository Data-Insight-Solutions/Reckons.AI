import { describe, it, expect } from 'vitest';
import { buildEntitySet, setMembers, isEntitySet, setMemberCount, defaultSetName, ENTITY_SET_TYPE, HAS_MEMBER } from '../entity-sets';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

describe('entity sets', () => {
  it('builds a set node with type, label, and member links', () => {
    const { setIri, statements } = buildEntitySet('Trip crew', ['urn:kbase:concept/alex', 'urn:kbase:concept/jordan']);
    expect(setIri).toMatch(/^urn:kbase:concept\/set-/);

    const typeStmt = statements.find((s) => s.p.value === RDF_TYPE);
    expect(typeStmt?.o).toMatchObject({ kind: 'iri', value: ENTITY_SET_TYPE });

    const label = statements.find((s) => s.p.value.endsWith('#label'));
    expect(label?.o).toMatchObject({ value: 'Trip crew' });

    const members = statements.filter((s) => s.p.value === HAS_MEMBER);
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
      s.p.value === HAS_MEMBER && s.o.kind === 'iri' && s.o.value === 'b' ? { ...s, status: 'rejected' as const } : s
    );
    expect(setMembers(setIri, withRejected)).toEqual(['a']);
  });

  it('defaultSetName reads from member labels', () => {
    const labelFor = (iri: string) => ({ a: 'Alex', b: 'Jordan', c: 'Sam', d: 'Kim' }[iri] ?? iri);
    expect(defaultSetName(['a', 'b'], labelFor)).toBe('Alex & Jordan set');
    expect(defaultSetName(['a', 'b', 'c', 'd'], labelFor)).toBe('Alex, Jordan +2 set');
    expect(defaultSetName([], labelFor)).toBe('New set');
  });
});
