import { describe, expect, it } from 'vitest';
import { buildProvenanceIndex, filterProvenanceIndex, projectProvenance, statementsForProvenanceNode, MAX_PROVENANCE_SOURCES } from '../provenance-view';
import { iri, lit, termKey, type Source, type Statement } from '../types';
import { COLLECTION, MEMBER, PREF_LABEL } from '../sets';
import { RDF_TYPE } from '../entity-types';

const source = (id: string): Source => ({ id, title: `Source ${id}`, uri: `note://${id}`, kind: 'note', ingestedAt: 10 });
const st = (id: string, subject: string, object: string, sourceId = 'a', extra: Partial<Statement> = {}): Statement => ({
  id, s: iri(`urn:test/${subject}`), p: iri('urn:kbase:predicate/description'), o: lit(object),
  sourceId, g: iri(`urn:kbase:source/${sourceId}`), status: 'confirmed', confidence: 0.8,
  createdAt: 10, updatedAt: 10, ...extra,
});
const key = (id: string) => `i:urn:test/${id}`;

describe('provenance source summaries', () => {
  it('intersects an existing set with the source, preserving original statements and overlapping sets', () => {
    const facts = [st('a', 'alice', 'researcher'), st('b', 'bob', 'designer'), st('c', 'carol', 'editor', 'b')];
    const sets = [
      st('type', 'team', '', 'schema', { p: iri(RDF_TYPE), o: iri(COLLECTION) }),
      st('label', 'team', 'Team', 'schema', { p: iri(PREF_LABEL) }),
      ...['alice', 'bob', 'carol'].map((id) => st(`member-${id}`, 'team', '', 'schema', { p: iri(MEMBER), o: iri(`urn:test/${id}`) })),
      st('type2', 'pair', '', 'schema', { p: iri(RDF_TYPE), o: iri(COLLECTION) }),
      ...['alice', 'bob'].map((id) => st(`pair-${id}`, 'pair', '', 'schema', { p: iri(MEMBER), o: iri(`urn:test/${id}`) })),
    ];
    const original = structuredClone([...facts, ...sets]);
    const index = buildProvenanceIndex([...facts, ...sets], [source('a'), source('b')]);
    const a = index.sources.find((s) => s.id === 'a')!;
    expect(a.groups).toHaveLength(2);
    expect(a.groups[0].members).toEqual([key('alice'), key('bob')]);
    expect(a.groups[0].statementIds).toEqual(['a', 'b']);
    const projection = projectProvenance(index, ['a'], new Set(a.groups.map((g) => g.key)));
    expect(projection.nodes.has(key('carol'))).toBe(false);
    expect([...projection.nodes.values()].filter((n) => n.kind === 'entity')).toHaveLength(2);
    expect([...facts, ...sets]).toEqual(original);
    expect(projection.edges.every((edge) => edge.altitude === 'log')).toBe(true);
    expect(facts[0].altitude).toBeUndefined();
  });

  it('keeps shared entities once when two source groups expand, without copying entity-to-entity facts', () => {
    const facts = [st('1', 'alice', 'engineer'), st('2', 'alice', 'researcher', 'b'), st('3', 'alice', '', 'b', { o: iri('urn:test/bob') })];
    const index = buildProvenanceIndex(facts, [source('a'), source('b')]);
    const collapsed = projectProvenance(index, ['a', 'b'], new Set());
    expect(collapsed.nodes.size).toBe(4); // two sources, two summaries
    const expanded = projectProvenance(index, ['a', 'b'], new Set(index.sources.flatMap((s) => s.groups.map((g) => g.key))));
    expect(expanded.nodes.size).toBe(6);
    expect(expanded.edges.some((edge) => termKey(edge.s) === key('alice') && termKey(edge.o) === key('bob'))).toBe(false);
    const alice = expanded.nodes.get(key('alice'))!;
    expect(statementsForProvenanceNode(index, alice, ['a']).map((s) => s.id)).toEqual(['1']);
    expect(statementsForProvenanceNode(index, alice, ['a', 'b']).map((s) => s.id)).toEqual(['1', '2', '3']);
  });

  it('retains rejected history but does not summarize it as current extracted knowledge', () => {
    const facts = [st('1', 'alice', 'pending', 'a', { status: 'pending' }), st('2', 'bob', 'discarded', 'a', { status: 'rejected' }), st('3', 'carol', 'replaced', 'a', { status: 'superseded' })];
    const index = buildProvenanceIndex(facts, [source('a')]);
    expect(index.sources[0].statements).toEqual(facts);
    expect(index.sources[0].entityKeys).toEqual([key('alice')]);
    expect(index.statements.get('1')?.status).toBe('pending');
  });

  it('keeps manual attribution distinct from missing source IDs and missing source metadata', () => {
    const index = buildProvenanceIndex([st('1', 'alice', 'a', 'manual'), st('2', 'bob', 'b', ''), st('3', 'carol', 'c', 'gone')], []);
    expect(index.sources.find((s) => s.id === 'manual')?.title).toBe('Your own statements');
    expect(index.sources.find((s) => s.id === '__unrecorded__')?.title).toBe('Source not recorded');
    expect(index.sources.find((s) => s.id === 'gone')?.source).toBeUndefined();
    expect(index.sources.find((s) => s.id === 'gone')?.title).toContain('unavailable');
  });

  it('does not turn type IRIs or presentation metadata targets into extracted entities', () => {
    const index = buildProvenanceIndex([
      st('type', 'alice', '', 'a', { p: iri(RDF_TYPE), o: iri('urn:kbase:type/Person') }),
      st('image', 'alice', '', 'a', { p: iri('urn:kbase:meta/glbModel'), o: iri('https://example.test/model.glb') }),
      st('orphan-source', 'alice', '', 'a', { p: iri('urn:kbase:predicate/extracted-from'), o: iri('urn:kbase:source/missing') }),
    ], [source('a')]);
    expect(index.sources[0].entityKeys).toEqual([key('alice')]);
  });

  it('enforces the source budget and keeps unselected, empty, and cleared views honest', () => {
    const sources = Array.from({ length: 8 }, (_, n) => source(String(n)));
    const index = buildProvenanceIndex([], sources);
    const view = projectProvenance(index, sources.map((s) => s.id), new Set());
    expect(view.sources).toHaveLength(MAX_PROVENANCE_SOURCES);
    expect(view.nodes.size).toBe(MAX_PROVENANCE_SOURCES);
    expect(view.edges).toHaveLength(0);
    expect(projectProvenance(index, [], new Set()).nodes.size).toBe(0);
  });

  it('keeps set identity, ordering and entity labels when review filters leave only one member', () => {
    const facts = [
      st('alice', 'alice', 'Engineer'),
      st('bob', 'bob', 'Researcher', 'a', { status: 'pending' }),
      st('bob-label', 'bob', 'Robert', 'schema', { p: iri(PREF_LABEL) }),
      st('type', 'team', '', 'schema', { p: iri(RDF_TYPE), o: iri(COLLECTION) }),
      st('label', 'team', 'Research team', 'schema', { p: iri(PREF_LABEL) }),
      ...['bob', 'alice'].map((id) => st(`member-${id}`, 'team', '', 'schema', { p: iri(MEMBER), o: iri(`urn:test/${id}`) })),
    ];
    const index = buildProvenanceIndex(facts, [source('a'), source('schema')]);
    const original = structuredClone(index);
    const group = index.sources.find((source) => source.id === 'a')!.groups[0];
    const filtered = filterProvenanceIndex(index, 'pending');
    const filteredSource = filtered.sources.find((source) => source.id === 'a')!;
    expect(filteredSource.groups).toEqual([{ ...group, members: [key('bob')], statementIds: ['bob'] }]);
    expect(filtered.entities.get(key('bob'))?.label).toBe('Robert');
    expect(filtered.entities.has(key('alice'))).toBe(false);
    expect(filtered.sources.find((source) => source.id === 'schema')?.groups).toEqual([]);
    const scene = projectProvenance(filtered, ['a'], new Set([group.key]));
    expect(scene.nodes.get(group.key)?.label).toBe('Research team · 1');
    expect(statementsForProvenanceNode(filtered, scene.nodes.get(group.key)!, ['a'])).toEqual([facts[1]]);
    expect(index).toEqual(original);
    expect(filterProvenanceIndex(index, 'all')).toBe(index);
  });

  it('filters confirmed and refined contributions without exposing rejected or superseded history', () => {
    const statuses = ['confirmed', 'refined', 'pending', 'rejected', 'superseded', 'pending-removal'] as const;
    const index = buildProvenanceIndex(statuses.map((status) => st(status, status, status, '', { status })), []);
    const filtered = filterProvenanceIndex(index, 'confirmed');
    expect(filtered.sources[0].id).toBe('__unrecorded__');
    expect(filtered.sources[0].statements.map((st) => st.id)).toEqual(['confirmed', 'refined']);
    expect(filtered.sources[0].groups[0].members).toEqual([key('confirmed'), key('refined')]);
    expect([...filtered.statements.keys()]).toEqual(['confirmed', 'refined']);
  });
});
