import { describe, it, expect } from 'vitest';
import { toJsonLd, toLlmsTxt } from '../semantic-export';
import type { Statement } from '$lib/rdf/types';
import { iri, lit } from '$lib/rdf/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

let _id = 0;
function makeStatement(overrides: Partial<Statement> = {}): Statement {
  return {
    id: `stmt-${++_id}`,
    s: iri('urn:kbase:concept/alice'),
    p: iri('http://www.w3.org/2000/01/rdf-schema#label'),
    o: lit('Alice'),
    g: iri('urn:kbase:source/src1'),
    sourceId: 'src1',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

// ── toJsonLd ──────────────────────────────────────────────────────────────────

describe('toJsonLd', () => {
  it('returns an object with @context and @graph', () => {
    const doc = toJsonLd([makeStatement()]) as Record<string, unknown>;
    expect(doc['@context']).toBe('https://schema.org/');
    expect(Array.isArray(doc['@graph'])).toBe(true);
  });

  it('produces one node per unique subject IRI', () => {
    const s1 = makeStatement({ s: iri('urn:kbase:concept/alice'), p: iri(RDFS_LABEL), o: lit('Alice') });
    const s2 = makeStatement({ s: iri('urn:kbase:concept/bob'),   p: iri(RDFS_LABEL), o: lit('Bob') });
    const s3 = makeStatement({ s: iri('urn:kbase:concept/alice'), p: iri('urn:kbase:predicate/age'), o: lit('30') });
    const doc = toJsonLd([s1, s2, s3]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph']).toHaveLength(2);
  });

  it('excludes pending statements', () => {
    const pending = makeStatement({ status: 'pending' });
    const doc = toJsonLd([pending]) as { '@graph': unknown[] };
    expect(doc['@graph']).toHaveLength(0);
  });

  it('excludes rejected statements', () => {
    const rejected = makeStatement({ status: 'rejected' });
    const doc = toJsonLd([rejected]) as { '@graph': unknown[] };
    expect(doc['@graph']).toHaveLength(0);
  });

  it('includes refined statements', () => {
    const refined = makeStatement({ status: 'refined' });
    const doc = toJsonLd([refined]) as { '@graph': unknown[] };
    expect(doc['@graph']).toHaveLength(1);
  });

  it('maps rdf:type to @type', () => {
    const s1 = makeStatement({ p: iri(RDF_TYPE), o: iri('urn:kbase:type/Person') });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph'][0]['@type']).toBe('Person');
  });

  it('maps unknown rdf:type to slug label', () => {
    const s1 = makeStatement({ p: iri(RDF_TYPE), o: iri('urn:kbase:type/CustomThing') });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph'][0]['@type']).toBe('CustomThing');
  });

  it('maps rdfs:label to name', () => {
    const s1 = makeStatement({ p: iri(RDFS_LABEL), o: lit('Alice Smith') });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph'][0]['name']).toBe('Alice Smith');
  });

  it('maps known kb predicates to schema.org keys', () => {
    const s1 = makeStatement({ p: iri('urn:kbase:predicate/email'), o: lit('alice@example.com') });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph'][0]['email']).toBe('alice@example.com');
  });

  it('uses slug label for unknown predicates', () => {
    const s1 = makeStatement({ p: iri('urn:kbase:predicate/favorite-color'), o: lit('blue') });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph'][0]['favorite color']).toBe('blue');
  });

  it('represents IRI objects as {@id: ...}', () => {
    const s1 = makeStatement({
      s: iri('urn:kbase:concept/alice'),
      p: iri('urn:kbase:predicate/knows'),
      o: iri('urn:kbase:concept/bob')
    });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    const val = doc['@graph'][0]['knows'];
    expect(val).toEqual({ '@id': 'urn:kbase:concept/bob' });
  });

  it('merges multiple values for the same predicate into an array', () => {
    const s1 = makeStatement({ p: iri('urn:kbase:predicate/tag'), o: lit('a') });
    const s2 = makeStatement({ p: iri('urn:kbase:predicate/tag'), o: lit('b') });
    const doc = toJsonLd([s1, s2]) as { '@graph': Record<string, unknown>[] };
    const tags = doc['@graph'][0]['tag'];
    expect(Array.isArray(tags)).toBe(true);
    expect(tags).toContain('a');
    expect(tags).toContain('b');
  });

  it('falls back to Thing for nodes without a type', () => {
    const s1 = makeStatement({ p: iri('urn:kbase:predicate/note'), o: lit('something') });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph'][0]['@type']).toBe('Thing');
  });

  it('sets subject @id from the IRI', () => {
    const s1 = makeStatement({ s: iri('urn:kbase:concept/alice') });
    const doc = toJsonLd([s1]) as { '@graph': Record<string, unknown>[] };
    expect(doc['@graph'][0]['@id']).toBe('urn:kbase:concept/alice');
  });

  it('includes kbTitle and kbDescription in document root when provided', () => {
    const doc = toJsonLd([makeStatement()], { kbTitle: 'My KB', kbDescription: 'Test KB' }) as Record<string, unknown>;
    expect(doc['name']).toBe('My KB');
    expect(doc['description']).toBe('Test KB');
  });

  it('returns empty @graph for empty statements', () => {
    const doc = toJsonLd([]) as { '@graph': unknown[] };
    expect(doc['@graph']).toHaveLength(0);
  });
});

// ── toLlmsTxt ─────────────────────────────────────────────────────────────────

describe('toLlmsTxt', () => {
  it('starts with an H1 title', () => {
    const txt = toLlmsTxt([], { kbTitle: 'My KB' });
    expect(txt.startsWith('# My KB')).toBe(true);
  });

  it('uses default title when none provided', () => {
    const txt = toLlmsTxt([]);
    expect(txt).toContain('# Knowledge Graph');
  });

  it('includes description in blockquote', () => {
    const txt = toLlmsTxt([], { kbDescription: 'A test knowledge base.' });
    expect(txt).toContain('> A test knowledge base.');
  });

  it('excludes pending statements', () => {
    const pending = makeStatement({ status: 'pending', p: iri(RDFS_LABEL), o: lit('Hidden') });
    const txt = toLlmsTxt([pending]);
    expect(txt).not.toContain('Hidden');
  });

  it('includes confirmed entity names', () => {
    const s1 = makeStatement({ p: iri(RDFS_LABEL), o: lit('Alice Smith') });
    const txt = toLlmsTxt([s1]);
    expect(txt).toContain('Alice Smith');
  });

  it('creates a section for known Schema.org type', () => {
    const type = makeStatement({ p: iri(RDF_TYPE), o: iri('urn:kbase:type/Person') });
    const label = makeStatement({ p: iri(RDFS_LABEL), o: lit('Alice') });
    const txt = toLlmsTxt([type, label]);
    expect(txt).toContain('## Persons');
    expect(txt).toContain('Alice');
  });

  it('includes key facts in entity line', () => {
    const email = makeStatement({ p: iri('urn:kbase:predicate/email'), o: lit('alice@example.com') });
    const txt = toLlmsTxt([email]);
    expect(txt).toContain('email');
    expect(txt).toContain('alice@example.com');
  });

  it('includes a Key Relations section for IRI→IRI triples', () => {
    const st = makeStatement({
      s: iri('urn:kbase:concept/alice'),
      p: iri('urn:kbase:predicate/knows'),
      o: iri('urn:kbase:concept/bob')
    });
    const txt = toLlmsTxt([st]);
    expect(txt).toContain('## Key Relations');
    expect(txt).toContain('alice');
    expect(txt).toContain('knows');
    expect(txt).toContain('bob');
  });

  it('does not include a Key Relations section when there are none', () => {
    const st = makeStatement({ p: iri(RDFS_LABEL), o: lit('Alice') });
    const txt = toLlmsTxt([st]);
    expect(txt).not.toContain('## Key Relations');
  });

  it('includes siteUrl when provided', () => {
    const txt = toLlmsTxt([], { siteUrl: 'https://example.com' });
    expect(txt).toContain('https://example.com');
  });

  it('returns a non-empty string for empty statements', () => {
    const txt = toLlmsTxt([]);
    expect(txt.length).toBeGreaterThan(0);
    expect(txt).toContain('# Knowledge Graph');
  });
});
