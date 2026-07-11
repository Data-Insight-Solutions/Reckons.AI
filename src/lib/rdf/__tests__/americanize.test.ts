import { describe, it, expect } from 'vitest';
import { americanizeText, applyCase, sweepLiterals, scanIdentifiers } from '../americanize';

describe('americanize spelling map', () => {
  it('normalizes -ise / -isation families', () => {
    expect(americanizeText('serialisation').out).toBe('serialization');
    expect(americanizeText('normalise the data').out).toBe('normalize the data');
    expect(americanizeText('organisational').out).toBe('organizational');
    expect(americanizeText('summarises').out).toBe('summarizes');
  });

  it('handles irregulars', () => {
    expect(americanizeText('colour and behaviour').out).toBe('color and behavior');
    expect(americanizeText('neighbourhood').out).toBe('neighborhood');
    expect(americanizeText('the centre').out).toBe('the center');
    expect(americanizeText('a licence').out).toBe('a license');
    expect(americanizeText('analyse').out).toBe('analyze');
  });

  it('preserves case', () => {
    expect(applyCase('Normalisation', 'normalization')).toBe('Normalization');
    expect(applyCase('COLOUR', 'color')).toBe('COLOR');
    expect(americanizeText('Entity Normalisation').out).toBe('Entity Normalization');
  });

  it('does not touch unrelated words (rise, wise, promise, exercise)', () => {
    const text = 'the sunrise made him wise; I promise to exercise';
    expect(americanizeText(text).count).toBe(0);
    expect(americanizeText(text).out).toBe(text);
  });
});

describe('sweepLiterals — literals only, IRIs untouched', () => {
  it('rewrites inside string literals but not IRIs or prefixed names', () => {
    const ttl = [
      'kb:entity-normalisation',
      '    rdfs:label "Entity Normalisation" ;',
      '    rdfs:comment "handles normalisation and colour" ;',
      '    p:see <urn:kbase:concept/colour-organiser> .',
    ].join('\n');

    const { out, count } = sweepLiterals(ttl);
    expect(count).toBe(3); // Normalisation, normalisation, colour
    // literals changed
    expect(out).toContain('"Entity Normalization"');
    expect(out).toContain('"handles normalization and color"');
    // identifiers untouched
    expect(out).toContain('kb:entity-normalisation');
    expect(out).toContain('<urn:kbase:concept/colour-organiser>');
  });

  it('handles triple-quoted literals', () => {
    const ttl = 'kb:x rdfs:comment """optimise and prioritise""" .';
    expect(sweepLiterals(ttl).out).toContain('"""optimize and prioritize"""');
  });

  it('leaves @prefix lines alone', () => {
    const ttl = '@prefix centre: <urn:centre/> .\nkb:x rdfs:label "the centre" .';
    const out = sweepLiterals(ttl).out;
    expect(out).toContain('@prefix centre: <urn:centre/> .');
    expect(out).toContain('"the center"');
  });
});

describe('scanIdentifiers — reports British spellings in identifiers', () => {
  it('flags prefixed names and IRIs, ignoring literals', () => {
    const ttl = [
      'feat:EntityNormalisation rdfs:label "Entity Normalization" .',
      'kb:entity-normalisation p:x <urn:reckons:feature/EntityNormalisation> .',
    ].join('\n');
    const ids = scanIdentifiers(ttl);
    expect(ids).toContain('feat:EntityNormalisation');
    expect(ids).toContain('kb:entity-normalisation');
    expect(ids).toContain('<urn:reckons:feature/EntityNormalisation>');
  });

  it('returns nothing when identifiers are already American', () => {
    const ttl = 'kb:entity-normalization rdfs:label "colour" .';
    expect(scanIdentifiers(ttl)).toHaveLength(0);
  });
});
