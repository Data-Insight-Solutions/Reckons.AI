import { describe, it, expect } from 'vitest';
import { Parser } from 'n3';
import { checkTypes, checkEnum, unionMembers, schemeNotations, shInIris } from '../taxonomy-current.ts';

const ttl = (body: string) => new Parser().parse(`
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix ktype: <urn:kbase:type/> .
@prefix kterm: <urn:kbase:term/> .
${body}`);

const T = (label: string, slug = label.replace(/\W/g, '')) => ({ iri: `urn:kbase:type/${slug}`, label, description: `d ${label}` });

describe('checkTypes', () => {
  it('passes a type named by a term label', () => {
    const q = ttl('kterm:gadget a skos:Concept ; skos:prefLabel "gadget" .');
    expect(checkTypes(q, q, [T('Gadget')])).toEqual([]);
  });
  it('passes a type whose IRI the vocabulary mentions', () => {
    const q = ttl('ktype:Widget a rdfs:Class .');
    expect(checkTypes(q, q, [T('Widget')])).toEqual([]);
  });
  it('reports a type with no term', () => {
    const q = ttl('kterm:other a skos:Concept ; skos:prefLabel "other" .');
    const g = checkTypes(q, q, [T('Gizmo')]);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: 'type-no-term', subject: 'urn:kbase:type/Gizmo', description: 'd Gizmo' });
  });
  it('reports a term naming a type the code lacks', () => {
    const q = ttl('kterm:old a skos:Concept ; skos:exactMatch ktype:Gone .');
    expect(checkTypes(q, q, []).map((g) => g.kind)).toEqual(['term-stale-type']);
  });
  it('does not call a declared class stale', () => {
    const q = ttl('kterm:p a skos:Concept ; skos:exactMatch ktype:Proposal . ktype:Proposal a rdfs:Class .');
    expect(checkTypes(q, q, [])).toEqual([]);
  });
});

describe('enums', () => {
  it('reads union members and ignores comments containing semicolons', () => {
    expect(unionMembers("export type S =\n | 'a' // x; y\n | 'b';", 'S')).toEqual(['a', 'b']);
  });
  it('compares in both directions', () => {
    const g = checkEnum('s', ['a', 'b'], new Set(['b', 'c']));
    expect(g.map((x) => x.kind).sort()).toEqual(['enum-extra', 'enum-missing']);
    expect(checkEnum('s', ['a'], new Set(['a']))).toEqual([]);
  });
  it('reads scheme notations and sh:in lists', () => {
    const q = ttl(`ktype:S a skos:ConceptScheme . kterm:x skos:inScheme ktype:S ; skos:notation "x" .
      [] sh:path <https://schema.org/p> ; sh:in ( <urn:a> <urn:b> ) .`);
    expect([...schemeNotations(q, 'urn:kbase:type/S')]).toEqual(['x']);
    expect(shInIris(q, 'https://schema.org/p')).toEqual(['urn:a', 'urn:b']);
  });
});
