/**
 * W3C Turtle conformance tests.
 *
 * These tests validate that our serialization (toTurtle, toTurtleFull) produces
 * valid Turtle per the W3C spec (https://www.w3.org/TR/turtle/) and that our
 * import pipeline (importTurtleFull, parseGhostGraph) correctly handles
 * standard Turtle constructs.
 *
 * N3.js is the reference parser — it passes the W3C Turtle test suite.
 * If N3.js can parse our output and recover the original data, we're conformant.
 */

import { describe, it, expect } from 'vitest';
import { toTurtle, toTurtleFull, toNQuads, parseNQuads } from '../serialize';
import { importTurtleFull } from '../import-ttl';
import { parseGhostGraph } from '../ghost-graph';
import type { Statement, Source } from '../types';
import { iri, lit, bnode } from '../types';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _id = 0;
function mkStmt(overrides: Partial<Statement> = {}): Statement {
  return {
    id: `w3c-${++_id}`,
    s: iri('urn:kbase:concept/alpha'),
    p: iri('http://www.w3.org/2000/01/rdf-schema#label'),
    o: lit('Alpha'),
    g: iri('urn:kbase:source/test'),
    sourceId: 'test',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1719705600000, // 2024-06-30T00:00:00Z
    updatedAt: 1719705600000,
    ...overrides,
  };
}

function mkSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'test',
    title: 'Test Source',
    uri: 'https://example.com',
    ingestedAt: 1719705600000,
    kind: 'url',
    ...overrides,
  };
}

/** Parse TTL with N3.js and return quads. */
async function parseWithN3(ttl: string) {
  const { Parser } = await import('n3');
  return new Parser({ format: 'Turtle' }).parse(ttl);
}

/** Count quads that are not reification/source metadata (i.e. the "real" triples). */
function countDirectTriples(quads: any[]): number {
  return quads.filter(q => {
    const sv: string = q.subject.value;
    return !sv.startsWith('urn:kbase:stmt/') && !sv.startsWith('urn:kbase:source/');
  }).length;
}

// ── 1. Turtle syntax — N3.js parsability ─────────────────────────────────────

describe('toTurtle output is valid W3C Turtle', () => {
  it('produces parseable Turtle for basic statements', async () => {
    const ttl = toTurtle([mkStmt()], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads.length).toBeGreaterThanOrEqual(1);
  });

  it('produces parseable Turtle for multiple subjects', async () => {
    const stmts = [
      mkStmt({ s: iri('urn:kbase:concept/alpha') }),
      mkStmt({ id: 'w3c-extra', s: iri('urn:kbase:concept/beta'), o: lit('Beta') }),
    ];
    const ttl = toTurtle(stmts, { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads.length).toBe(2);
  });

  it('produces parseable Turtle with provenance', async () => {
    const ttl = toTurtle([mkStmt()], { includeProvenance: true });
    const quads = await parseWithN3(ttl);
    // At least the statement triple + provenance reification
    expect(quads.length).toBeGreaterThanOrEqual(2);
  });

  it('produces parseable Turtle for empty statement list', async () => {
    const ttl = toTurtle([]);
    // Empty TTL should still be valid (comments + prefixes, no triples)
    const quads = await parseWithN3(ttl);
    expect(quads.length).toBe(0);
  });
});

// ── 2. Prefix declarations ───────────────────────────────────────────────────

describe('W3C Turtle prefix declarations', () => {
  it('emits @prefix with trailing period', () => {
    const ttl = toTurtle([mkStmt()]);
    const prefixLines = ttl.split('\n').filter(l => l.startsWith('@prefix'));
    for (const line of prefixLines) {
      expect(line).toMatch(/^@prefix \w+: <[^>]+> \.$/);
    }
  });

  it('uses prefixed names for known namespaces', () => {
    const ttl = toTurtle([mkStmt()], { includeProvenance: false });
    expect(ttl).toContain('rdfs:label');
    expect(ttl).toContain('kb:alpha');
  });

  it('falls back to full IRI for unknown namespaces', () => {
    const stmt = mkStmt({ p: iri('http://xmlns.com/foaf/0.1/knows') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    expect(ttl).toContain('<http://xmlns.com/foaf/0.1/knows>');
  });
});

// ── 3. Literals — datatypes and language tags ────────────────────────────────

describe('W3C Turtle literal encoding', () => {
  it('encodes plain string literals', async () => {
    const stmt = mkStmt({ o: lit('Hello world') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    const obj = quads.find((q: any) => q.predicate.value.includes('label'))?.object;
    expect(obj?.value).toBe('Hello world');
  });

  it('encodes language-tagged literals', async () => {
    const stmt = mkStmt({ o: lit('Bonjour', undefined, 'fr') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    expect(ttl).toContain('@fr');
    const quads = await parseWithN3(ttl);
    const obj = quads[0]?.object;
    expect(obj?.value).toBe('Bonjour');
    expect(obj?.language).toBe('fr');
  });

  it('encodes typed literals with ^^', async () => {
    const stmt = mkStmt({
      p: iri('urn:kbase:predicate/age'),
      o: lit('42', 'http://www.w3.org/2001/XMLSchema#integer'),
    });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    expect(ttl).toContain('^^');
    const quads = await parseWithN3(ttl);
    const obj = quads[0]?.object;
    expect(obj?.value).toBe('42');
    expect(obj?.datatype?.value).toBe('http://www.w3.org/2001/XMLSchema#integer');
  });

  it('omits ^^xsd:string for plain literals (W3C default)', async () => {
    const stmt = mkStmt({ o: lit('plain text') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    // Should NOT contain ^^xsd:string — that's the default
    expect(ttl).not.toContain('^^xsd:string');
    expect(ttl).not.toContain('^^<http://www.w3.org/2001/XMLSchema#string>');
  });

  it('escapes quotes in string literals', async () => {
    const stmt = mkStmt({ o: lit('She said "hello" and left') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads[0]?.object.value).toBe('She said "hello" and left');
  });

  it('escapes backslashes in string literals', async () => {
    const stmt = mkStmt({ o: lit('path\\to\\file') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads[0]?.object.value).toBe('path\\to\\file');
  });

  it('handles newlines in literal values', async () => {
    const stmt = mkStmt({ o: lit('line one\nline two') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads[0]?.object.value).toBe('line one\nline two');
  });

  it('handles empty string literals', async () => {
    const stmt = mkStmt({ o: lit('') });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads[0]?.object.value).toBe('');
  });
});

// ── 4. Subject grouping and punctuation ──────────────────────────────────────

describe('W3C Turtle subject grouping', () => {
  it('groups predicates under the same subject with ;', () => {
    const stmts = [
      mkStmt({ p: iri('http://www.w3.org/2000/01/rdf-schema#label'), o: lit('Alpha') }),
      mkStmt({ id: 'w3c-g2', p: iri('http://www.w3.org/2000/01/rdf-schema#comment'), o: lit('A test') }),
    ];
    const ttl = toTurtle(stmts, { includeProvenance: false });
    // Subject should appear exactly once
    const subjectOccurrences = (ttl.match(/kb:alpha/g) || []).length;
    expect(subjectOccurrences).toBe(1);
    // Should have semicolons between predicates
    expect(ttl).toContain(';');
    // Last predicate of a subject block ends with .
    expect(ttl).toMatch(/\.\s*$/m);
  });

  it('separates different subjects into distinct blocks', async () => {
    const stmts = [
      mkStmt({ s: iri('urn:kbase:concept/alpha'), o: lit('Alpha') }),
      mkStmt({ id: 'w3c-s2', s: iri('urn:kbase:concept/beta'), o: lit('Beta') }),
    ];
    const ttl = toTurtle(stmts, { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    const subjects = new Set(quads.map((q: any) => q.subject.value));
    expect(subjects.size).toBe(2);
  });
});

// ── 5. IRI handling ──────────────────────────────────────────────────────────

describe('W3C Turtle IRI handling', () => {
  it('wraps full IRIs in angle brackets', () => {
    const stmt = mkStmt({
      s: iri('http://example.org/resource/1'),
      p: iri('http://example.org/predicate/name'),
    });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    expect(ttl).toContain('<http://example.org/resource/1>');
    expect(ttl).toContain('<http://example.org/predicate/name>');
  });

  it('handles URN-style IRIs', async () => {
    const stmt = mkStmt({
      s: iri('urn:isbn:978-3-16-148410-0'),
      p: iri('http://www.w3.org/2000/01/rdf-schema#label'),
      o: lit('A Book'),
    });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads[0]?.subject.value).toBe('urn:isbn:978-3-16-148410-0');
  });

  it('handles IRI objects (not just literals)', async () => {
    const stmt = mkStmt({
      o: iri('urn:kbase:concept/beta'),
    });
    const ttl = toTurtle([stmt], { includeProvenance: false });
    const quads = await parseWithN3(ttl);
    expect(quads[0]?.object.termType).toBe('NamedNode');
    expect(quads[0]?.object.value).toBe('urn:kbase:concept/beta');
  });
});

// ── 6. toTurtleFull round-trip ───────────────────────────────────────────────

describe('toTurtleFull ↔ importTurtleFull round-trip', () => {
  it('round-trips a simple confirmed statement', async () => {
    const stmt = mkStmt();
    const src = mkSource();
    const ttl = toTurtleFull([stmt], [src]);
    const result = await importTurtleFull(ttl);

    expect(result.statements).toHaveLength(1);
    const rt = result.statements[0];
    expect(rt.s).toEqual(stmt.s);
    expect(rt.p).toEqual(stmt.p);
    expect(rt.o).toEqual(stmt.o);
    expect(rt.status).toBe('confirmed');
    expect(rt.confidence).toBe(0.9);
  });

  it('round-trips statements with all review statuses', async () => {
    const statuses = ['confirmed', 'refined', 'pending', 'rejected', 'superseded'] as const;
    const stmts = statuses.map((status, i) =>
      mkStmt({
        id: `status-${i}`,
        s: iri(`urn:kbase:concept/entity-${i}`),
        o: lit(`Value ${i}`),
        status,
      })
    );
    const ttl = toTurtleFull(stmts, [mkSource()]);
    const result = await importTurtleFull(ttl);

    expect(result.statements).toHaveLength(5);
    for (const status of statuses) {
      expect(result.statements.find(s => s.status === status)).toBeDefined();
    }
  });

  it('round-trips literal with datatype', async () => {
    const stmt = mkStmt({
      p: iri('urn:kbase:predicate/age'),
      o: lit('42', 'http://www.w3.org/2001/XMLSchema#integer'),
    });
    const ttl = toTurtleFull([stmt], [mkSource()]);
    const result = await importTurtleFull(ttl);
    expect(result.statements[0].o).toMatchObject({
      kind: 'literal',
      value: '42',
      datatype: 'http://www.w3.org/2001/XMLSchema#integer',
    });
  });

  it('round-trips literal with language tag', async () => {
    const stmt = mkStmt({ o: lit('Bonjour', undefined, 'fr') });
    const ttl = toTurtleFull([stmt], [mkSource()]);
    const result = await importTurtleFull(ttl);
    expect(result.statements[0].o).toMatchObject({
      kind: 'literal',
      value: 'Bonjour',
      lang: 'fr',
    });
  });

  it('round-trips IRI objects', async () => {
    const stmt = mkStmt({
      p: iri('http://www.w3.org/2004/02/skos/core#related'),
      o: iri('urn:kbase:concept/beta'),
    });
    const ttl = toTurtleFull([stmt], [mkSource()]);
    const result = await importTurtleFull(ttl);
    expect(result.statements[0].o).toEqual({ kind: 'iri', value: 'urn:kbase:concept/beta' });
  });

  it('round-trips gloss and excerpt metadata', async () => {
    const stmt = mkStmt({
      gloss: 'Alpha is related to Beta',
      excerpt: 'The original source sentence.',
    });
    const ttl = toTurtleFull([stmt], [mkSource()]);
    const result = await importTurtleFull(ttl);
    expect(result.statements[0].gloss).toBe('Alpha is related to Beta');
    expect(result.statements[0].excerpt).toBe('The original source sentence.');
  });

  it('round-trips source metadata', async () => {
    const src = mkSource({
      id: 'wiki-src',
      title: 'Wikipedia Article',
      uri: 'https://en.wikipedia.org/wiki/Test',
      kind: 'url',
      trustLevel: 'review',
    });
    const ttl = toTurtleFull([mkStmt()], [src]);
    const result = await importTurtleFull(ttl);
    const rtSrc = result.sources.find(s => s.id === 'wiki-src');
    expect(rtSrc).toBeDefined();
    expect(rtSrc!.title).toBe('Wikipedia Article');
    expect(rtSrc!.kind).toBe('url');
    expect(rtSrc!.trustLevel).toBe('review');
  });

  it('round-trips KB stable ID', async () => {
    const ttl = toTurtleFull([mkStmt()], [mkSource()], {
      kbStableId: 'urn:uuid:test-stable-123',
    });
    expect(ttl).toContain('urn:uuid:test-stable-123');
    // Verify it's parseable
    const quads = await parseWithN3(ttl);
    const stableIdQuad = quads.find(
      (q: any) => q.predicate.value === 'urn:reckons:meta/kbStableId'
    );
    expect(stableIdQuad).toBeDefined();
    expect(stableIdQuad?.object.value).toBe('urn:uuid:test-stable-123');
  });

  it('round-trips supersedes reference', async () => {
    const stmt = mkStmt({ supersedes: 'old-stmt-id' });
    const ttl = toTurtleFull([stmt], [mkSource()]);
    const result = await importTurtleFull(ttl);
    expect(result.statements[0].supersedes).toBe('old-stmt-id');
  });
});

// ── 7. Plain Turtle import (non-annotated) ───────────────────────────────────

describe('importTurtleFull — plain W3C Turtle import', () => {
  it('imports standard W3C Turtle as pending statements', async () => {
    const ttl = `
      @prefix foaf: <http://xmlns.com/foaf/0.1/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

      <http://example.org/alice> foaf:name "Alice" ;
                                  foaf:knows <http://example.org/bob> .

      <http://example.org/bob> rdfs:label "Bob" .
    `;
    const result = await importTurtleFull(ttl);
    expect(result.cleanImportCount).toBe(3);
    expect(result.statements).toHaveLength(3);
    expect(result.statements.every(s => s.status === 'pending')).toBe(true);
  });

  it('preserves IRIs from standard Turtle', async () => {
    const ttl = `
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      <http://example.org/resource> rdfs:label "Test" .
    `;
    const result = await importTurtleFull(ttl);
    expect(result.statements[0].s.value).toBe('http://example.org/resource');
    expect(result.statements[0].p.value).toBe('http://www.w3.org/2000/01/rdf-schema#label');
  });

  it('handles SKOS vocabulary', async () => {
    const ttl = `
      @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

      <urn:concept/AI> rdfs:label "Artificial Intelligence" ;
                       skos:definition "The simulation of human intelligence by machines." ;
                       skos:broader <urn:concept/CS> .
    `;
    const result = await importTurtleFull(ttl);
    expect(result.statements).toHaveLength(3);
    const defStmt = result.statements.find(
      s => s.p.value === 'http://www.w3.org/2004/02/skos/core#definition'
    );
    expect(defStmt?.o.value).toBe('The simulation of human intelligence by machines.');
  });

  it('handles RDF type declarations', async () => {
    const ttl = `
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      <urn:test/person1> rdf:type <urn:type/Person> ;
                         rdfs:label "Alice" .
    `;
    const result = await importTurtleFull(ttl);
    const typeStmt = result.statements.find(
      s => s.p.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
    );
    expect(typeStmt).toBeDefined();
    expect(typeStmt!.o.value).toBe('urn:type/Person');
  });

  it('handles the "a" shorthand for rdf:type', async () => {
    const ttl = `
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      <urn:test/x> a <urn:type/Thing> ;
                   rdfs:label "X" .
    `;
    const result = await importTurtleFull(ttl);
    const typeStmt = result.statements.find(
      s => s.p.value === 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
    );
    expect(typeStmt).toBeDefined();
  });
});

// ── 8. Ghost graph parser — W3C Turtle ───────────────────────────────────────

describe('parseGhostGraph — W3C Turtle compliance', () => {
  it('parses standard prefixed Turtle', async () => {
    const ttl = `
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix skos: <http://www.w3.org/2004/02/skos/core#> .

      <urn:concept/A> rdfs:label "Concept A" ;
                      skos:related <urn:concept/B> .
      <urn:concept/B> rdfs:label "Concept B" .
    `;
    const g = await parseGhostGraph(ttl);
    expect(g.nodes).toHaveLength(2);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].predicate).toBe('http://www.w3.org/2004/02/skos/core#related');
  });

  it('handles BASE declaration', async () => {
    const ttl = `
      @base <http://example.org/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      <resource/A> rdfs:label "A" .
      <resource/B> rdfs:label "B" .
    `;
    const g = await parseGhostGraph(ttl);
    expect(g.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it('handles multiple prefixes including custom ones', async () => {
    const ttl = `
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix foaf: <http://xmlns.com/foaf/0.1/> .
      @prefix ex: <http://example.org/> .

      ex:alice foaf:name "Alice" ;
               foaf:knows ex:bob .
      ex:bob rdfs:label "Bob" .
    `;
    const g = await parseGhostGraph(ttl);
    expect(g.nodes.length).toBeGreaterThanOrEqual(2);
    expect(g.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('handles typed literals (ignores them as edge targets)', async () => {
    const ttl = `
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
      <urn:test/x> rdfs:label "Test" ;
                   <urn:pred/age> "42"^^xsd:integer .
    `;
    const g = await parseGhostGraph(ttl);
    // Typed literal should not become a node or edge
    expect(g.edges).toHaveLength(0);
    expect(g.nodes).toHaveLength(1);
  });
});

// ── 9. Real-world KB Turtle ──────────────────────────────────────────────────

describe('parseGhostGraph — real-world Reckons KB patterns', () => {
  it('parses a multi-prefix production-style TTL', async () => {
    const ttl = `
      @prefix kb:     <urn:kbase:concept/> .
      @prefix kpred:  <urn:kbase:predicate/> .
      @prefix kmeta:  <urn:kbase:meta/> .
      @prefix ktype:  <urn:kbase:type/> .
      @prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix skos:   <http://www.w3.org/2004/02/skos/core#> .

      kb:reckons-ai rdf:type ktype:Application ;
                    rdfs:label "Reckons.AI" ;
                    kpred:built-with kb:sveltekit ;
                    kpred:has-feature kb:knowledge-graph .

      kb:sveltekit rdf:type ktype:Framework ;
                   rdfs:label "SvelteKit" ;
                   kpred:version "2.x" .

      kb:knowledge-graph rdf:type ktype:Feature ;
                         rdfs:label "Knowledge Graph" ;
                         skos:broader kb:reckons-ai .
    `;
    const g = await parseGhostGraph(ttl);
    // 3 entities
    expect(g.nodes).toHaveLength(3);
    expect(g.nodes.find(n => n.label === 'Reckons.AI')).toBeDefined();
    expect(g.nodes.find(n => n.label === 'SvelteKit')).toBeDefined();
    expect(g.nodes.find(n => n.label === 'Knowledge Graph')).toBeDefined();

    // Edges: built-with, has-feature, broader (rdf:type is excluded)
    expect(g.edges.length).toBe(3);
  });

  it('parses KB identity and leap predicates without creating edges', async () => {
    const ttl = `
      @prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix ktype: <urn:kbase:type/> .

      <urn:reckons:kb> <urn:reckons:meta/kbStableId> "stable-123" .

      <urn:leap/target> rdf:type ktype:KnowledgeBase ;
                        rdfs:label "Target KB" ;
                        <urn:reckons:leap> "target-stable" ;
                        <urn:reckons:leap/label> "Target" .
    `;
    const g = await parseGhostGraph(ttl);
    // leap and kbStableId should not produce edges
    expect(g.edges).toHaveLength(0);
    // But the entities should still exist as nodes
    expect(g.nodes.find(n => n.label === 'Target KB')).toBeDefined();
  });
});

// ── 10. N-Quads — W3C conformance ───────────────────────────────────────────

describe('N-Quads round-trip W3C conformance', () => {
  it('round-trips xsd:dateTime typed literals', () => {
    const stmt = mkStmt({
      o: lit('2024-06-30T12:00:00Z', 'http://www.w3.org/2001/XMLSchema#dateTime'),
    });
    const nq = toNQuads([stmt]);
    const parsed = parseNQuads(nq);
    expect(parsed[0].o).toMatchObject({
      kind: 'literal',
      value: '2024-06-30T12:00:00Z',
      datatype: 'http://www.w3.org/2001/XMLSchema#dateTime',
    });
  });

  it('round-trips xsd:decimal typed literals', () => {
    const stmt = mkStmt({
      o: lit('3.14', 'http://www.w3.org/2001/XMLSchema#decimal'),
    });
    const nq = toNQuads([stmt]);
    const parsed = parseNQuads(nq);
    expect(parsed[0].o).toMatchObject({
      kind: 'literal',
      value: '3.14',
      datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
    });
  });

  it('round-trips xsd:boolean typed literals', () => {
    const stmt = mkStmt({
      o: lit('true', 'http://www.w3.org/2001/XMLSchema#boolean'),
    });
    const nq = toNQuads([stmt]);
    const parsed = parseNQuads(nq);
    expect(parsed[0].o).toMatchObject({
      kind: 'literal',
      value: 'true',
      datatype: 'http://www.w3.org/2001/XMLSchema#boolean',
    });
  });

  it('round-trips multiple language-tagged literals', () => {
    const stmts = [
      mkStmt({ id: 'en-1', o: lit('Hello', undefined, 'en') }),
      mkStmt({ id: 'fr-1', s: iri('urn:kbase:concept/beta'), o: lit('Bonjour', undefined, 'fr') }),
      mkStmt({ id: 'de-1', s: iri('urn:kbase:concept/gamma'), o: lit('Hallo', undefined, 'de') }),
    ];
    const nq = toNQuads(stmts);
    const parsed = parseNQuads(nq);
    expect(parsed).toHaveLength(3);
    expect(parsed[0].o).toMatchObject({ lang: 'en' });
    expect(parsed[1].o).toMatchObject({ lang: 'fr' });
    expect(parsed[2].o).toMatchObject({ lang: 'de' });
  });
});

// ── 11. Shelly persona round-trip ────────────────────────────────────────────

describe('toTurtleFull — Shelly persona block', () => {
  it('emits parseable Turtle for Shelly persona', async () => {
    const ttl = toTurtleFull([mkStmt()], [mkSource()], {
      shellyPersona: {
        name: 'Shelly',
        greeting: 'Hello!',
        personality: 'witty',
      },
    });
    // Must be valid Turtle
    const quads = await parseWithN3(ttl);
    const shellyQuads = quads.filter(
      (q: any) => q.predicate.value.startsWith('urn:reckons:shelly/')
    );
    expect(shellyQuads.length).toBeGreaterThanOrEqual(2);
  });

  it('round-trips Shelly persona through import', async () => {
    const ttl = toTurtleFull([mkStmt()], [mkSource()], {
      shellyPersona: {
        name: 'Shelly',
        greeting: 'Welcome!',
        personality: 'sarcastic',
        voiceEnabled: true,
        size: 'large',
      },
    });
    const result = await importTurtleFull(ttl);
    expect(result.shellyPersona).toBeDefined();
    expect(result.shellyPersona!.name).toBe('Shelly');
    expect(result.shellyPersona!.greeting).toBe('Welcome!');
    expect(result.shellyPersona!.personality).toBe('sarcastic');
    expect(result.shellyPersona!.voiceEnabled).toBe(true);
    expect(result.shellyPersona!.size).toBe('large');
  });
});
