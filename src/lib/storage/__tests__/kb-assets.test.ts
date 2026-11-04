/**
 * parseAssetRefs — finding asset reference triples in TTL text.
 *
 * Synthetic fixtures only. The original implementation was a line regex that matched just the
 * strict `<full-iri> <full-iri> "value" .` shape, so refs written with prefixes or inside a
 * predicate list were never found and their binary assets silently did not reattach on import.
 * The parser path now finds those; the regex remains the fallback for text that does not parse.
 */
import { describe, it, expect } from 'vitest';
import { parseAssetRefs } from '../kb-assets';

describe('parseAssetRefs — full-IRI form (the shape the old regex matched)', () => {
  it('finds <iri> <urn:kbase:asset/preview> "path" .', () => {
    const ttl = '<urn:reckons:guide/ReckonsAI> <urn:kbase:asset/preview> "assets/previews/turtle.gif" .';
    expect(parseAssetRefs(ttl)).toEqual([
      { entityIri: 'urn:reckons:guide/ReckonsAI', category: 'previews', value: 'assets/previews/turtle.gif' },
    ]);
  });

  it('recognises the legacy predicates', () => {
    expect(parseAssetRefs('<urn:e/a> <urn:kbase:meta/glbModel> "assets/models/a.glb" .')).toEqual([
      { entityIri: 'urn:e/a', category: 'models', value: 'assets/models/a.glb' },
    ]);
    expect(parseAssetRefs('<urn:e/a> <urn:kbase:meta/gifPreview> "assets/previews/a.gif" .')).toEqual([
      { entityIri: 'urn:e/a', category: 'previews', value: 'assets/previews/a.gif' },
    ]);
    expect(parseAssetRefs('<urn:e/a> <urn:kbase:predicate/icon2d> "assets/icons/a.svg" .')).toEqual([
      { entityIri: 'urn:e/a', category: 'icons', value: 'assets/icons/a.svg' },
    ]);
  });

  it('a new predicate wins over the legacy one for the same entity and slot', () => {
    const ttl = [
      '<urn:e/a> <urn:kbase:asset/icon> "assets/icons/new.svg" ;',
      '    <urn:kbase:predicate/icon2d> "assets/icons/old.svg" .',
    ].join('\n');
    expect(parseAssetRefs(ttl)).toEqual([
      { entityIri: 'urn:e/a', category: 'icons', value: 'assets/icons/new.svg' },
    ]);
  });

  it('skips non-literal objects and triples on other predicates', () => {
    const ttl = [
      '<urn:e/a> <urn:kbase:asset/icon> <urn:e/other> .',
      '<urn:e/b> <http://www.w3.org/2000/01/rdf-schema#label> "not an asset" .',
    ].join('\n');
    expect(parseAssetRefs(ttl)).toEqual([]);
  });
});

describe('parseAssetRefs — prefixed subjects/predicates and predicate lists', () => {
  it('finds a prefixed ref inside a predicate list', () => {
    const ttl = `
      @prefix kb: <urn:reckons:guide/> .
      @prefix kasset: <urn:kbase:asset/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

      kb:ReckonsAI kasset:preview "assets/previews/turtle.gif" ;
          rdfs:label "Reckons.AI" .
    `;
    expect(parseAssetRefs(ttl)).toEqual([
      { entityIri: 'urn:reckons:guide/ReckonsAI', category: 'previews', value: 'assets/previews/turtle.gif' },
    ]);
  });

  it('finds a legacy predicate written with a prefix', () => {
    const ttl = `
      @prefix kmeta: <urn:kbase:meta/> .
      <urn:e/a> kmeta:gifPreview "assets/previews/a.gif" .
    `;
    expect(parseAssetRefs(ttl)).toEqual([
      { entityIri: 'urn:e/a', category: 'previews', value: 'assets/previews/a.gif' },
    ]);
  });

  it('still finds a full-IRI ref that is mid-predicate-list (the old regex required the final ".")', () => {
    const ttl = '<urn:e/a> <urn:kbase:asset/preview> "assets/previews/p.gif" ; <http://www.w3.org/2000/01/rdf-schema#label> "x" .';
    expect(parseAssetRefs(ttl)).toEqual([
      { entityIri: 'urn:e/a', category: 'previews', value: 'assets/previews/p.gif' },
    ]);
  });
});

describe('parseAssetRefs — unparseable text falls back to the line regex', () => {
  it('still recovers a strict full-IRI line when the parser rejects the file', () => {
    // A truncated prefix declaration makes N3 throw; the regex path still finds the strict line.
    const ttl = '<urn:e/a> <urn:kbase:asset/preview> "assets/previews/p.gif" .\n@prefix broken:\n';
    expect(parseAssetRefs(ttl)).toEqual([
      { entityIri: 'urn:e/a', category: 'previews', value: 'assets/previews/p.gif' },
    ]);
  });
});
