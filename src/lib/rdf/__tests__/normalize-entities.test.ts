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
    // OPPOSED predicates that a real embedding scores HIGH — these are not hypothetical.
    // tests/bench/run-predicate-vocab-bench.ts measured e5-small-v2 at 0.9322 for
    // has-predator/has-prey and 0.9330 for has-min-weight/has-max-weight, both above the 0.88 the
    // normaliser rewrites at. Vectors here are pitched to match, so the veto is tested against the
    // situation that actually occurs rather than a comfortable one.
    'has predator':     [0.90, 0.44, 0.00, 0.00],
    'has prey':         [0.93, 0.37, 0.00, 0.00],
    'has min weight':   [0.00, 0.90, 0.44, 0.00],
    'has max weight':   [0.00, 0.93, 0.37, 0.00],
    // A legitimate synonym of has-predator that scores HIGH but strictly LOWER than the antonym
    // has-prey does (0.982 vs 0.997 against has-predator). That ordering is the whole point of the
    // shadowing test below: the antonym wins the ranking, so a veto applied afterwards would
    // suppress this valid remap instead of stepping over it.
    'has natural enemy': [0.80, 0.60, 0.00, 0.00],
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

  // ── Antonym veto on the write path ───────────────────────────────────────
  //
  // Added 2026-08-15. normalize-entities REWRITES a predicate before any human sees the fact, and
  // it had no opposition guard at all — the equivalent check was module-private to semantic-diff.ts
  // and protected only the advisory diff. These tests pin the veto against measured cosines rather
  // than convenient ones; see the vector table above.

  it('never remaps a predicate onto its opposite, however high the similarity', async () => {
    // has-predator ≈ has-prey scores well above 0.88 here, exactly as e5-small-v2 scores it.
    // Merging them reverses the food chain in the user's graph, silently.
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/has-predator'),
        o: iri('urn:kbase:concept/moray-eel'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/has-prey'),
        o: iri('urn:kbase:concept/crab'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.predicateRemaps).toBe(0);
    expect(result.statements[0].p.value).toBe('urn:kbase:predicate/has-predator');
  });

  it('never collapses the bounds of a range into each other', async () => {
    // has-min-weight → has-max-weight would turn a range into a contradiction.
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/has-min-weight'),
        o: lit('3kg'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/has-max-weight'),
        o: lit('5kg'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.predicateRemaps).toBe(0);
  });

  it('the veto is applied while ranking, so an antonym cannot shadow a real synonym', async () => {
    // Incoming has-predator. The graph holds BOTH its opposite (has-prey, cosine 0.997 — the top
    // scorer) and a legitimate synonym (has-natural-enemy, 0.982). Vetoing during ranking steps
    // over has-prey and remaps to has-natural-enemy. Vetoing AFTER a winner is picked would find
    // has-prey at the top, reject it, and drop the valid remap with it — a silent loss rather than
    // a silent corruption, but a loss caused by the guard itself.
    const incoming = [
      stmt({
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/has-predator'),
        o: iri('urn:kbase:concept/moray-eel'),
      }),
    ];
    const existing = [
      stmt({
        id: 'e1',
        s: iri('urn:kbase:concept/common-octopus'),
        p: iri('urn:kbase:predicate/has-prey'),
        o: iri('urn:kbase:concept/crab'),
        status: 'confirmed',
      }),
      stmt({
        id: 'e2',
        s: iri('urn:kbase:concept/giant-squid'),
        p: iri('urn:kbase:predicate/has-natural-enemy'),
        o: iri('urn:kbase:concept/sperm-whale'),
        status: 'confirmed',
      }),
    ];
    const result = await normalizeEntities(incoming, existing);
    expect(result.predicateRemaps).toBe(1);
    expect(result.statements[0].p.value).toBe('urn:kbase:predicate/has-natural-enemy');
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
