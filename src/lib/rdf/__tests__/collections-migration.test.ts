import { describe, it, expect } from 'vitest';
import { migrateEntitySetsToCollections } from '../collections-migration';
import { buildEntitySet, setMembers, isEntitySet, ENTITY_SET_TYPE, HAS_MEMBER, COLLECTION, MEMBER } from '../entity-sets';
import { readSets } from '../sets';
import type { Statement } from '../types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
let n = 0;
function st(s: string, p: string, o: string, lit = false, status: Statement['status'] = 'confirmed'): Statement {
  return {
    id: `id${n++}`, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p },
    o: lit ? { kind: 'literal', value: o } : { kind: 'iri', value: o },
    g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual',
    confidence: 1, status, createdAt: 1, updatedAt: 1,
  } as Statement;
}

const legacy = (): Statement[] => [
  st('kb:crew', RDF_TYPE, ENTITY_SET_TYPE),
  st('kb:crew', RDFS_LABEL, 'Trip crew', true),
  st('kb:crew', HAS_MEMBER, 'kb:alex'),
  st('kb:crew', HAS_MEMBER, 'kb:jordan', false, 'rejected'),
  st('kb:alex', RDF_TYPE, 'urn:kbase:type/Person'),
  st('kb:alex', 'urn:kbase:predicate/knows', 'kb:jordan'),
];

describe('migrateEntitySetsToCollections', () => {
  it('rewrites the type and every has-member, nothing else', () => {
    const before = legacy();
    const { statements, changed } = migrateEntitySetsToCollections(before);
    expect(changed).toHaveLength(3);
    expect(statements).toHaveLength(before.length);
    expect(statements[0].o.value).toBe(COLLECTION);
    expect(statements[2].p.value).toBe(MEMBER);
    expect(statements[3].p.value).toBe(MEMBER);
    // Unrelated rows are the SAME objects; ids, status and the rest of each rewritten row survive.
    for (const i of [1, 4, 5]) expect(statements[i]).toBe(before[i]);
    expect(statements.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(statements[3].status).toBe('rejected');
  });

  it('does not mutate its input', () => {
    const before = legacy();
    const snap = JSON.stringify(before);
    migrateEntitySetsToCollections(before);
    expect(JSON.stringify(before)).toBe(snap);
  });

  it('is idempotent', () => {
    const once = migrateEntitySetsToCollections(legacy());
    const twice = migrateEntitySetsToCollections(once.statements);
    expect(twice.changed).toEqual([]);
    expect(twice.statements).toEqual(once.statements);
  });

  it('round trip: members and set-ness survive, and the sets layer reads it', () => {
    const { statements } = migrateEntitySetsToCollections(legacy());
    expect(isEntitySet('kb:crew', statements)).toBe(true);
    expect(setMembers('kb:crew', statements)).toEqual(['kb:alex']); // rejected one stays rejected
    const quads = statements.map((x) => ({
      subject: { value: x.s.value }, predicate: { value: x.p.value }, object: { value: x.o.value },
    }));
    const [set] = readSets(quads);
    expect(set.iri).toBe('kb:crew');
    expect(set.label).toBe('Trip crew');
    expect(set.memberPredicates).toEqual([]);
    expect(JSON.stringify(statements)).not.toContain(ENTITY_SET_TYPE);
    expect(JSON.stringify(statements)).not.toContain(HAS_MEMBER);
  });

  it('leaves already-current collections untouched', () => {
    const { statements } = buildEntitySet('New', ['a', 'b']);
    const r = migrateEntitySetsToCollections(statements);
    expect(r.changed).toEqual([]);
    expect(r.statements).toEqual(statements);
  });

  it('does not rewrite a literal that merely spells the legacy type', () => {
    const lit = st('kb:x', RDF_TYPE, ENTITY_SET_TYPE, true);
    expect(migrateEntitySetsToCollections([lit]).changed).toEqual([]);
  });
});
