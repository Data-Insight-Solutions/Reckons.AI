import { describe, it, expect } from 'vitest';
import { parseTriplesJSON, triplesToStatements } from '../extractor';
import type { ExtractedTriple } from '../extractor';
import type { Source } from '$lib/rdf/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeSource(overrides: Partial<Source> = {}): Source {
  return {
    id: 'src-1',
    title: 'Test Source',
    uri: 'note://test',
    ingestedAt: 1000,
    kind: 'note',
    ...overrides
  };
}

const MINIMAL_TRIPLE: ExtractedTriple = {
  subject: 'alice',
  predicate: 'knows',
  object: 'bob'
};

// ── parseTriplesJSON ──────────────────────────────────────────────────────────

describe('parseTriplesJSON', () => {
  it('parses a clean JSON array', () => {
    const raw = JSON.stringify([MINIMAL_TRIPLE]);
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('alice');
  });

  it('strips markdown json fences', () => {
    const raw = '```json\n[{"subject":"a","predicate":"b","object":"c"}]\n```';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('strips generic code fences', () => {
    const raw = '```\n[{"subject":"a","predicate":"b","object":"c"}]\n```';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('handles leading prose before the array', () => {
    const raw = 'Here are the triples:\n[{"subject":"a","predicate":"b","object":"c"}]';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('handles trailing text after the array', () => {
    const raw = '[{"subject":"a","predicate":"b","object":"c"}]\nDone.';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('throws when no JSON array is present', () => {
    expect(() => parseTriplesJSON('No array here')).toThrow('No JSON array found');
  });

  it('throws when no array start bracket exists', () => {
    expect(() => parseTriplesJSON('{')).toThrow();
  });

  it('repairs truncated array missing closing bracket', () => {
    const raw = '[{"subject":"alice","predicate":"knows","object":"bob"},{"subject":"carol","predicate":"knows","object":"dave"}';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(2);
    expect(result[0].subject).toBe('alice');
    expect(result[1].subject).toBe('carol');
  });

  it('repairs truncated array cut mid-object', () => {
    // Simulates token-limit truncation: first object complete, second cut off
    const raw = '[{"subject":"alice","predicate":"knows","object":"bob"},{"subject":"carol","predicate":"kno';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('alice');
  });

  it('repairs truncated array with trailing comma after last object', () => {
    const raw = '[{"subject":"alice","predicate":"knows","object":"bob"},';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('repairs truncated JSON when } appears inside string values', () => {
    const raw = '[{"subject":"a","predicate":"b","object":"c","excerpt":"text with } inside"},{"subject":"d","predicate":"e","object":"f","excerpt":"more } text and trunc';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('a');
  });

  it('repairs real SmolLM2-style truncated output', () => {
    const raw = '```json\n[{"subject":"common-octopus","predicate":"is-a","object":"marine-mollusk","confidence":0.9},{"subject":"octopus","predicate":"has-heart-count","object":"3","objectIsLiteral":true,"confidence":0.95},{"subject":"octopus","predicate":"has-color","object":"blue","confidence":';
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(2);
    expect(result[0].subject).toBe('common-octopus');
    expect(result[1].object).toBe('3');
  });

  it('filters out entries missing subject', () => {
    const raw = JSON.stringify([
      { predicate: 'knows', object: 'bob' },
      { subject: 'alice', predicate: 'knows', object: 'bob' }
    ]);
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
    expect(result[0].subject).toBe('alice');
  });

  it('filters out entries missing predicate', () => {
    const raw = JSON.stringify([
      { subject: 'alice', object: 'bob' },
      { subject: 'alice', predicate: 'knows', object: 'bob' }
    ]);
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('filters out entries with null object', () => {
    const raw = JSON.stringify([
      { subject: 'alice', predicate: 'knows', object: null },
      { subject: 'alice', predicate: 'knows', object: 'bob' }
    ]);
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('allows object value of 0 (falsy but valid)', () => {
    const raw = JSON.stringify([{ subject: 'count', predicate: 'has-value', object: 0, objectIsLiteral: true }]);
    const result = parseTriplesJSON(raw);
    expect(result).toHaveLength(1);
  });

  it('returns empty array for empty array input', () => {
    expect(parseTriplesJSON('[]')).toHaveLength(0);
  });

  it('parses all optional fields when present', () => {
    const triple: ExtractedTriple = {
      subject: 'alice',
      predicate: 'born-on',
      object: '1990-01-01',
      objectIsLiteral: true,
      datatype: 'date',
      gloss: 'Alice was born on 1990-01-01.',
      confidence: 0.95
    };
    const result = parseTriplesJSON(JSON.stringify([triple]));
    expect(result[0].objectIsLiteral).toBe(true);
    expect(result[0].datatype).toBe('date');
    expect(result[0].gloss).toBe('Alice was born on 1990-01-01.');
    expect(result[0].confidence).toBe(0.95);
  });
});

// ── triplesToStatements ───────────────────────────────────────────────────────

describe('triplesToStatements', () => {
  it('produces one Statement per triple', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE], makeSource());
    expect(stmts).toHaveLength(1);
  });

  it('sets subject IRI under urn:kbase:concept/', () => {
    const stmts = triplesToStatements([{ subject: 'Alice Smith', predicate: 'x', object: 'y' }], makeSource());
    expect(stmts[0].s.value).toMatch(/^urn:kbase:concept\//);
    expect(stmts[0].s.value).toContain('alice-smith');
  });

  it('sets predicate IRI under urn:kbase:predicate/', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE], makeSource());
    expect(stmts[0].p.value).toMatch(/^urn:kbase:predicate\//);
    expect(stmts[0].p.value).toContain('knows');
  });

  it('produces a literal object when objectIsLiteral=true', () => {
    const triple: ExtractedTriple = {
      subject: 'alice',
      predicate: 'age',
      object: '30',
      objectIsLiteral: true,
      datatype: 'number'
    };
    const stmts = triplesToStatements([triple], makeSource());
    expect(stmts[0].o.kind).toBe('literal');
    expect(stmts[0].o.value).toBe('30');
  });

  it('attaches xsd datatype to literals when datatype provided', () => {
    const triple: ExtractedTriple = {
      subject: 'alice', predicate: 'born', object: '1990-01-01',
      objectIsLiteral: true, datatype: 'date'
    };
    const stmts = triplesToStatements([triple], makeSource());
    const o = stmts[0].o;
    expect(o.kind).toBe('literal');
    if (o.kind === 'literal') {
      expect(o.datatype).toContain('dateTime');
    }
  });

  it('produces an IRI object when objectIsLiteral is absent/false', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE], makeSource());
    expect(stmts[0].o.kind).toBe('iri');
    expect(stmts[0].o.value).toMatch(/^urn:kbase:concept\//);
  });

  it('sets sourceId from source.id', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE], makeSource({ id: 'src-42' }));
    expect(stmts[0].sourceId).toBe('src-42');
  });

  it('sets graph IRI from source.id', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE], makeSource({ id: 'src-42' }));
    expect(stmts[0].g.value).toBe('urn:kbase:source/src-42');
  });

  it('defaults confidence to 0.7 when not provided', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE], makeSource());
    expect(stmts[0].confidence).toBe(0.7);
  });

  it('uses provided confidence value', () => {
    const triple = { ...MINIMAL_TRIPLE, confidence: 0.95 };
    const stmts = triplesToStatements([triple], makeSource());
    expect(stmts[0].confidence).toBe(0.95);
  });

  it('sets status to pending', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE], makeSource());
    expect(stmts[0].status).toBe('pending');
  });

  it('stores gloss when provided', () => {
    const triple = { ...MINIMAL_TRIPLE, gloss: 'Alice knows Bob.' };
    const stmts = triplesToStatements([triple], makeSource());
    expect(stmts[0].gloss).toBe('Alice knows Bob.');
  });

  it('assigns unique UUIDs to each statement', () => {
    const stmts = triplesToStatements([MINIMAL_TRIPLE, MINIMAL_TRIPLE], makeSource());
    expect(stmts[0].id).not.toBe(stmts[1].id);
  });

  it('slugifies subject with spaces and special characters', () => {
    const triple = { subject: 'Dr. Alice O\'Brien!', predicate: 'works-at', object: 'Hospital' };
    const stmts = triplesToStatements([triple], makeSource());
    const slug = stmts[0].s.value.replace('urn:kbase:concept/', '');
    expect(slug).not.toContain(' ');
    expect(slug).not.toContain('!');
    expect(slug).not.toContain("'");
  });

  it('converts uppercase predicate to lowercase IRI', () => {
    const triple = { subject: 'x', predicate: 'HAS-PROPERTY', object: 'y' };
    const stmts = triplesToStatements([triple], makeSource());
    expect(stmts[0].p.value).toBe('urn:kbase:predicate/has-property');
  });

  it('returns empty array for empty input', () => {
    expect(triplesToStatements([], makeSource())).toHaveLength(0);
  });
});

// ── Passage grounding wired through the real conversion path (kb:passage-grounding) ──
//
// The pure verifier is tested in rdf/__tests__/grounding.test.ts. What matters HERE is
// that the extraction pipeline actually calls it — a verifier nothing invokes is theatre.
describe('triplesToStatements — excerpt grounding', () => {
  const SOURCE_TEXT = 'The octopus has three hearts and blue blood.';

  const withExcerpt = (excerpt: string) => ({
    subject: 'octopus',
    predicate: 'has-heart-count',
    object: '3',
    objectIsLiteral: true,
    confidence: 0.95,
    excerpt,
  });

  it('keeps and marks an excerpt that really is in the source', () => {
    const [s] = triplesToStatements([withExcerpt('The octopus has three hearts')], makeSource(), SOURCE_TEXT);
    expect(s.grounded).toBe(true);
    expect(s.excerpt).toBe('The octopus has three hearts');
    expect(s.confidence).toBe(0.95);
  });

  it('DROPS a fabricated excerpt and penalises confidence', () => {
    const [s] = triplesToStatements(
      [withExcerpt('The octopus has nine brains and a beak of iron.')], // invented
      makeSource(),
      SOURCE_TEXT,
    );
    expect(s.grounded).toBe(false);
    expect(s.excerpt).toBeUndefined();      // never render a forged citation
    expect(s.confidence).toBeLessThan(0.95); // and trust the model less here
  });

  it('leaves excerpts unverified when no source text is supplied — never a fabricated pass', () => {
    const [s] = triplesToStatements([withExcerpt('anything')], makeSource());
    expect(s.excerpt).toBe('anything');
    expect(s.grounded).toBeUndefined();
  });
});
