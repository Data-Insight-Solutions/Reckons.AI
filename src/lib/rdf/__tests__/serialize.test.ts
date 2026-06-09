import { describe, it, expect } from 'vitest';
import { toTurtle, toNQuads, parseNQuads, DEFAULT_PREFIXES } from '../serialize';
import type { Statement } from '../types';
import { iri, lit } from '../types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeStatement(overrides: Partial<Statement> = {}): Statement {
  return {
    id: 'test-id-1',
    s: iri('urn:kbase:concept/coffee'),
    p: iri('http://www.w3.org/2000/01/rdf-schema#label'),
    o: lit('Coffee'),
    g: iri('urn:kbase:source/src1'),
    sourceId: 'src1',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1000000,
    updatedAt: 1000000,
    ...overrides
  };
}

// ── toTurtle ─────────────────────────────────────────────────────────────────

describe('toTurtle', () => {
  it('outputs prefix declarations', () => {
    const ttl = toTurtle([makeStatement()]);
    expect(ttl).toContain('@prefix kb: <urn:kbase:concept/>');
    expect(ttl).toContain('@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>');
  });

  it('includes confirmed statements', () => {
    const ttl = toTurtle([makeStatement({ status: 'confirmed' })]);
    expect(ttl).toContain('kb:coffee');
    expect(ttl).toContain('"Coffee"');
  });

  it('excludes pending statements by default', () => {
    const ttl = toTurtle([makeStatement({ status: 'pending' })]);
    expect(ttl).not.toContain('kb:coffee');
  });

  it('includes pending statements when status filter overridden', () => {
    const ttl = toTurtle(
      [makeStatement({ status: 'pending' })],
      { includeStatuses: ['pending'] }
    );
    expect(ttl).toContain('kb:coffee');
  });

  it('groups multiple predicates under one subject', () => {
    const s1 = makeStatement({ p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit('Coffee') });
    const s2 = makeStatement({ id: 'test-id-2', p: iri('http://www.w3.org/2000/01/rdf-schema#comment'), o: lit('A beverage') });
    const ttl = toTurtle([s1, s2]);
    // Subject should appear once; both predicates under it
    const matches = ttl.match(/kb:coffee/g);
    expect(matches?.length).toBe(1);
    expect(ttl).toContain('rdfs:label');
    expect(ttl).toContain('rdfs:comment');
  });

  it('uses semicolon between predicates and period on last', () => {
    const s1 = makeStatement({ p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit('Coffee') });
    const s2 = makeStatement({ id: 'test-id-2', p: iri('http://www.w3.org/2000/01/rdf-schema#comment'), o: lit('A beverage') });
    const ttl = toTurtle([s1, s2], { includeProvenance: false });
    expect(ttl).toMatch(/rdfs:label "Coffee" ;/);
    expect(ttl).toMatch(/rdfs:comment "A beverage" \./);
  });

  it('uses full IRI brackets for unknown prefixes', () => {
    const ttl = toTurtle([makeStatement({ p: iri('http://example.org/unknown/pred') })]);
    expect(ttl).toContain('<http://example.org/unknown/pred>');
  });

  it('emits provenance block when enabled', () => {
    const ttl = toTurtle([makeStatement()], { includeProvenance: true });
    expect(ttl).toContain('prov:wasDerivedFrom');
    expect(ttl).toContain('urn:kbase:stmt/test-id-1');
  });

  it('skips provenance when disabled', () => {
    const ttl = toTurtle([makeStatement()], { includeProvenance: false });
    expect(ttl).not.toContain('prov:wasDerivedFrom');
  });

  it('handles empty statement list', () => {
    const ttl = toTurtle([]);
    expect(ttl).toContain('0 statements');
    expect(ttl).toContain('@prefix');
  });
});

// ── toNQuads / parseNQuads round-trip ─────────────────────────────────────────

describe('toNQuads + parseNQuads round-trip', () => {
  it('round-trips a simple IRI triple', () => {
    const st = makeStatement({
      s: iri('urn:kbase:concept/coffee'),
      p: iri('http://www.w3.org/2000/01/rdf-schema#label'),
      o: iri('urn:kbase:concept/beverage'),
      g: iri('urn:kbase:source/src1')
    });
    const nq = toNQuads([st]);
    const parsed = parseNQuads(nq);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].s).toEqual({ kind: 'iri', value: 'urn:kbase:concept/coffee' });
    expect(parsed[0].p).toEqual({ kind: 'iri', value: 'http://www.w3.org/2000/01/rdf-schema#label' });
    expect(parsed[0].o).toEqual({ kind: 'iri', value: 'urn:kbase:concept/beverage' });
    expect(parsed[0].g).toEqual({ kind: 'iri', value: 'urn:kbase:source/src1' });
  });

  it('round-trips a literal object', () => {
    const st = makeStatement({ o: lit('Hello world') });
    const nq = toNQuads([st]);
    const parsed = parseNQuads(nq);
    expect(parsed[0].o).toEqual({ kind: 'literal', value: 'Hello world', lang: undefined, datatype: undefined });
  });

  it('round-trips a literal with lang tag', () => {
    const st = makeStatement({ o: lit('Bonjour', undefined, 'fr') });
    const nq = toNQuads([st]);
    const parsed = parseNQuads(nq);
    expect(parsed[0].o).toMatchObject({ kind: 'literal', value: 'Bonjour', lang: 'fr' });
  });

  it('round-trips a literal with datatype', () => {
    const st = makeStatement({ o: lit('42', 'http://www.w3.org/2001/XMLSchema#integer') });
    const nq = toNQuads([st]);
    const parsed = parseNQuads(nq);
    expect(parsed[0].o).toMatchObject({ kind: 'literal', value: '42', datatype: 'http://www.w3.org/2001/XMLSchema#integer' });
  });

  it('round-trips a literal with quotes', () => {
    const st = makeStatement({ o: lit('He said "hello"') });
    const nq = toNQuads([st]);
    const parsed = parseNQuads(nq);
    expect(parsed[0].o).toMatchObject({ kind: 'literal', value: 'He said "hello"' });
  });

  it('skips comment lines', () => {
    const parsed = parseNQuads('# this is a comment\n<urn:a> <urn:b> <urn:c> <urn:g> .\n# end');
    expect(parsed).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const parsed = parseNQuads('\n\n<urn:a> <urn:b> <urn:c> <urn:g> .\n\n');
    expect(parsed).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(parseNQuads('')).toEqual([]);
    expect(parseNQuads('# only comments\n')).toEqual([]);
  });
});
