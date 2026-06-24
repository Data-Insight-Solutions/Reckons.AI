import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock embedder ────────────────────────────────────────────────────────────
// Same pattern as semantic-diff.test.ts: deterministic 4-dim vectors.

vi.mock('$lib/embed', () => {
  const VECS: Record<string, number[]> = {
    // Near-identical entity pairs (cosine > 0.90)
    'common octopus':   [0.99, 0.10, 0.00, 0.00],
    'octopus vulgaris': [0.98, 0.12, 0.01, 0.00],
    // Distinct entities (cosine ~ 0.10)
    'coffee':           [0.00, 0.00, 0.99, 0.10],
    'morning routine':  [0.00, 0.00, 0.10, 0.99],
    // Near-identical predicate pairs (cosine > 0.88)
    'has habitat':      [0.95, 0.30, 0.00, 0.00],
    'lives in':         [0.94, 0.32, 0.01, 0.00],
    // Distinct predicates
    'has color':        [0.00, 0.00, 0.95, 0.30],
    'weighs':           [0.00, 0.00, 0.30, 0.95],
  };

  function norm(v: number[]): Float32Array {
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return new Float32Array(v.map(x => x / mag));
  }

  function getVec(label: string): Float32Array {
    const v = VECS[label.toLowerCase().trim()];
    if (v) return norm(v);
    const seed = label.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0);
    return norm([Math.sin(seed), Math.cos(seed), Math.sin(seed + 1), Math.cos(seed + 1)]);
  }

  return {
    embedMany: (labels: string[]) => Promise.resolve(labels.map(getVec)),
    cosine: (a: Float32Array, b: Float32Array) => {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return dot;
    },
  };
});

import { normalizeEntities } from '../normalize-entities';
import type { Statement } from '../types';
import { iri, lit } from '../types';

let _id = 0;
function stmt(overrides: Partial<Statement> = {}): Statement {
  return {
    id: `s${++_id}`,
    s: iri('urn:kbase:concept/alice'),
    p: iri('urn:kbase:predicate/knows'),
    o: iri('urn:kbase:concept/bob'),
    g: iri('urn:kbase:source/test'),
    sourceId: 'test',
    confidence: 0.8,
    status: 'pending',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => { _id = 0; });

describe('normalizeEntities', () => {
  it('returns unchanged statements when nothing to normalise', async () => {
    const incoming = [stmt()];
    const existing = [stmt({ id: 'e1' })]; // same IRIs
    const result = await normalizeEntities(incoming, existing);
    expect(result.subjectRemaps).toBe(0);
    expect(result.predicateRemaps).toBe(0);
    expect(result.statements).toEqual(incoming);
  });

  it('returns unchanged statements when KB is empty', async () => {
    const incoming = [stmt()];
    const result = await normalizeEntities(incoming, []);
    expect(result.subjectRemaps).toBe(0);
    expect(result.statements).toEqual(incoming);
  });

  it('remaps subject IRI to existing entity by embedding similarity', async () => {
    // Incoming: "octopus-vulgaris", existing: "common-octopus"
    // These have cosine > 0.90 in our mock
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/octopus-vulgaris'),
        p: iri('urn:kbase:predicate/has-color'),
        o: lit('red'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/weighs'),
        o: lit('5kg'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.subjectRemaps).toBe(1);
    expect(result.statements[0].s.value).toBe('urn:kbase:concept/common-octopus');
  });

  it('remaps object IRI to existing entity', async () => {
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/diver'),
        p: iri('urn:kbase:predicate/studies'),
        o: iri('urn:kbase:concept/octopus-vulgaris'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/weighs'),
        o: lit('5kg'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    // "octopus-vulgaris" in object position should map to "common-octopus"
    expect(result.statements[0].o.value).toBe('urn:kbase:concept/common-octopus');
  });

  it('remaps predicate IRI to existing predicate by embedding similarity', async () => {
    // "has-habitat" (incoming) ≈ "lives-in" (existing) — cosine > 0.88
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/has-habitat'),
        o: lit('ocean'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/lives-in'),
        o: lit('sea'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.predicateRemaps).toBe(1);
    expect(result.statements[0].p.value).toBe('urn:kbase:predicate/lives-in');
  });

  it('does not remap distinct entities below threshold', async () => {
    // "coffee" vs "morning-routine" — cosine ~ 0.10
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/coffee'),
        p: iri('urn:kbase:predicate/has-color'),
        o: lit('brown'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/morning-routine'),
        p: iri('urn:kbase:predicate/has-color'),
        o: lit('bright'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.subjectRemaps).toBe(0);
    expect(result.statements[0].s.value).toBe('urn:kbase:concept/coffee');
  });

  it('does not remap protected vocabulary predicates', async () => {
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/octopus'),
        p: iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        o: iri('urn:kbase:type/Animal'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/dog'),
        p: iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
        o: iri('urn:kbase:type/Animal'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.predicateRemaps).toBe(0);
    // rdf:type should stay exactly as-is
    expect(result.statements[0].p.value).toBe('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  });

  it('remaps by exact label match before embedding', async () => {
    // Exact label match: "Common-Octopus" → "common-octopus" (case-insensitive)
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/Common-Octopus'),
        p: iri('urn:kbase:predicate/has-color'),
        o: lit('red'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/weighs'),
        o: lit('5kg'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.subjectRemaps).toBe(1);
    expect(result.statements[0].s.value).toBe('urn:kbase:concept/common-octopus');
  });
});
