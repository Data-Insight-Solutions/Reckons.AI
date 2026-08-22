import { readFileSync } from 'fs';
import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';
import { containsUnnegatedMention, countPublishedGraph } from '../audit-rules';

describe('countPublishedGraph', () => {
  it('separates one app statement from its two exporter provenance triples', () => {
    const quads = new Parser().parse(`
      @prefix prov: <http://www.w3.org/ns/prov#> .
      @prefix dc: <http://purl.org/dc/terms/> .
      <urn:subject> <urn:predicate> <urn:object> .
      <urn:kbase:stmt/one> prov:wasDerivedFrom <urn:source> ;
        dc:created "2026-08-17T00:00:00.000Z" .
    `);

    expect(countPublishedGraph(quads)).toEqual({
      statements: 1,
      rdfQuads: 3,
      provenanceQuads: 2,
      advisoryQuads: 0,
    });
  });

  it('does not count the derived content advisory as an app statement', () => {
    const quads = new Parser().parse(`
      <urn:subject> <urn:predicate> "mature source text" .
      <urn:reckons:kb> <urn:reckons:meta/contentAdvisory> "mature: violence" .
    `);

    expect(countPublishedGraph(quads)).toMatchObject({
      statements: 1,
      rdfQuads: 2,
      advisoryQuads: 1,
    });
  });

  it('agrees with the checked-in public graph header', () => {
    const text = readFileSync('static/knowledge.ttl', 'utf8');
    const declared = Number(text.match(/^#\s*(\d+)\s+statements/im)?.[1]);
    const counts = countPublishedGraph(new Parser({ format: 'TriG' }).parse(text));

    expect(counts.statements).toBe(declared);
    expect(counts.rdfQuads).toBeGreaterThan(counts.statements);
  });
});

describe('containsUnnegatedMention', () => {
  it('keeps an ordinary present-tense capability claim', () => {
    expect(containsUnnegatedMention(
      'Graph Publication sends the graph to our hosted service.',
      'Graph Publication',
    )).toBe(true);
  });

  it('rejects a capability mention explicitly negated before the name', () => {
    expect(containsUnnegatedMention(
      'We do not host user graphs or mediate graph publication, but DIS can receive feedback.',
      'Graph Publication',
    )).toBe(false);
  });

  it('rejects a capability mention explicitly negated after the name', () => {
    expect(containsUnnegatedMention(
      'Graph Publication is not built.',
      'Graph Publication',
    )).toBe(false);
  });

  it('does not let negation in an earlier clause hide a later claim', () => {
    expect(containsUnnegatedMention(
      'The editor does not need a server, but Graph Publication works today.',
      'Graph Publication',
    )).toBe(true);
  });

  it('does not mistake a negated property for absence of the capability', () => {
    expect(containsUnnegatedMention(
      'Graph Publication does not require a Reckons server.',
      'Graph Publication',
    )).toBe(true);
  });

  it('does not mistake scoped nonexistence for absence of the capability', () => {
    expect(containsUnnegatedMention(
      'Graph Publication does not exist on a Reckons server; users publish to their own host.',
      'Graph Publication',
    )).toBe(true);
  });

  it('flags the sentence when any repeated mention is unnegated', () => {
    expect(containsUnnegatedMention(
      'Graph Publication is not built. Graph Publication works today.',
      'Graph Publication',
    )).toBe(true);
  });
});
