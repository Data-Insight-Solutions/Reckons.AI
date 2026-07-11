import { describe, it, expect } from 'vitest';
import { entityProtection } from '../protected-entities';
import type { Statement } from '../types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

let n = 0;
function st(s: string, p: string, o: string, oKind: 'iri' | 'literal' = 'iri', status: Statement['status'] = 'confirmed'): Statement {
  return {
    id: `s${n++}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: oKind === 'iri' ? { kind: 'iri', value: o } : { kind: 'literal', value: o, datatype: null, lang: null },
    status,
  } as Statement;
}

describe('entityProtection', () => {
  it('protects a type that other nodes instantiate', () => {
    const stmts = [
      st('urn:kbase:concept/a', RDF_TYPE, 'urn:kbase:type/Campground'),
      st('urn:kbase:concept/b', RDF_TYPE, 'urn:kbase:type/Campground'),
    ];
    const r = entityProtection('urn:kbase:type/Campground', stmts);
    expect(r.protected).toBe(true);
    expect(r.reason).toMatch(/2 nodes are typed as this/);
  });

  it('protects an entity-type definition even with no instances', () => {
    const stmts = [st('urn:kbase:type/Forecast', RDF_TYPE, 'urn:kbase:type/EntityType')];
    const r = entityProtection('urn:kbase:type/Forecast', stmts);
    expect(r.protected).toBe(true);
    expect(r.reason).toMatch(/entity-type definition/);
  });

  it('protects a leap source and a leap target', () => {
    const source = entityProtection('urn:kbase:concept/hub', [
      st('urn:kbase:concept/hub', 'urn:reckons:leap', 'stable-id-123'),
    ]);
    expect(source.protected).toBe(true);
    expect(source.reason).toMatch(/navigation \/ leap/);

    const target = entityProtection('urn:kbase:concept/target', [
      st('urn:kbase:concept/hub', 'urn:reckons:leap', 'urn:kbase:concept/target'),
    ]);
    expect(target.protected).toBe(true);
  });

  it('protects a node carrying nav ordering', () => {
    const r = entityProtection('urn:kbase:concept/x', [
      st('urn:kbase:concept/x', 'urn:reckons:nav/order', '3', 'literal'),
    ]);
    expect(r.protected).toBe(true);
  });

  it('protects a set node that groups members', () => {
    const r = entityProtection('urn:kbase:concept/set-1', [
      st('urn:kbase:concept/set-1', 'urn:kbase:predicate/has-member', 'urn:kbase:concept/a'),
      st('urn:kbase:concept/set-1', 'urn:kbase:predicate/has-member', 'urn:kbase:concept/b'),
    ]);
    expect(r.protected).toBe(true);
    expect(r.reason).toMatch(/set grouping 2 nodes/);
  });

  it('does NOT protect an ordinary node', () => {
    const stmts = [
      st('urn:kbase:concept/alex', RDF_TYPE, 'urn:kbase:type/Person'),
      st('urn:kbase:concept/alex', 'urn:kbase:predicate/lives-in', 'urn:kbase:concept/sf'),
    ];
    expect(entityProtection('urn:kbase:concept/alex', stmts).protected).toBe(false);
  });

  it('ignores rejected/superseded statements', () => {
    const stmts = [st('urn:kbase:concept/a', RDF_TYPE, 'urn:kbase:type/Ghost', 'iri', 'rejected')];
    expect(entityProtection('urn:kbase:type/Ghost', stmts).protected).toBe(false);
  });
});
