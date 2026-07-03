import { describe, it, expect, vi } from 'vitest';
import { iri, lit, type Statement } from '../types';
import type { CurrentItem } from '../current-ranking';

// ── Fake embedder ────────────────────────────────────────────────────────────
// Keeps cosine/cluster real (pure functions) but replaces embedMany with a
// deterministic bag-of-words vectorizer so affinity ranking is predictable
// without loading a real transformers.js model.

const VOCAB = ['coffee', 'tea', 'quantum', 'computing', 'garden', 'frontend', 'espresso'];

function fakeVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  const vec = new Float32Array(VOCAB.length);
  VOCAB.forEach((w, i) => {
    vec[i] = lower.includes(w) ? 1 : 0;
  });
  const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
  for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

vi.mock('../../embed', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../embed')>();
  return {
    ...actual,
    embedMany: vi.fn(async (texts: string[]) => texts.map(fakeVector))
  };
});

const { rankItems, topEntityLabels } = await import('../current-ranking');

// ── Helpers ──────────────────────────────────────────────────────────────────

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function stmt(s: string, p: string, o: Statement['o'], status: Statement['status'] = 'confirmed'): Statement {
  return {
    id: `${s}|${p}|${o.value}`,
    s: iri(s),
    p: iri(p),
    o,
    g: iri('urn:kbase:source/test'),
    sourceId: 'test',
    confidence: 0.9,
    status,
    createdAt: 1,
    updatedAt: 1
  };
}

function item(overrides: Partial<CurrentItem> = {}): CurrentItem {
  return {
    title: 'Untitled',
    url: 'https://example.com/a',
    currentSlug: 'hn',
    graphStableId: 'kb-1',
    fetchedAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

// ── topEntityLabels ──────────────────────────────────────────────────────────

describe('topEntityLabels', () => {
  it('ranks entities by triple degree and prefers rdfs:label over IRI local name', () => {
    const stmts: Statement[] = [
      stmt('urn:kbase:concept/coffee', RDF_TYPE, iri('urn:kbase:type/Concept')),
      stmt('urn:kbase:concept/coffee', RDFS_LABEL, lit('Morning Coffee')),
      stmt('urn:kbase:concept/coffee', 'urn:kbase:predicate/likes', lit('a lot')),
      stmt('urn:kbase:concept/tea', RDF_TYPE, iri('urn:kbase:type/Concept'))
    ];
    const labels = topEntityLabels(stmts, 2);
    expect(labels[0]).toBe('Morning Coffee'); // highest degree (3 triples) + has a label
    expect(labels).toContain('tea'); // no label → falls back to IRI local name
  });

  it('excludes meta predicates and inactive statements from degree counting', () => {
    const stmts: Statement[] = [
      stmt('urn:kbase:concept/x', 'urn:reckons:meta/currents/sourceUrl', lit('https://a.example')),
      stmt('urn:kbase:concept/y', RDF_TYPE, iri('urn:kbase:type/Concept'), 'rejected')
    ];
    expect(topEntityLabels(stmts, 5)).toEqual([]);
  });

  it('returns [] for an empty graph', () => {
    expect(topEntityLabels([], 5)).toEqual([]);
  });
});

// ── rankItems ────────────────────────────────────────────────────────────────

describe('rankItems', () => {
  const graphStmts: Statement[] = [
    stmt('urn:kbase:concept/coffee', RDF_TYPE, iri('urn:kbase:type/Concept')),
    stmt('urn:kbase:concept/coffee', RDFS_LABEL, lit('coffee')),
    stmt('urn:kbase:concept/coffee', 'urn:kbase:predicate/notes', lit('daily ritual')),
    stmt('urn:kbase:concept/coffee', 'urn:kbase:predicate/notes2', lit('daily ritual again'))
  ];

  it('ranks items with higher affinity to the graph above unrelated ones', async () => {
    const items = [
      item({ title: 'Garden tips for spring', url: 'https://example.com/garden' }),
      item({ title: 'Best espresso and coffee makers of 2026', url: 'https://example.com/coffee' })
    ];
    const ranked = await rankItems(items, graphStmts);
    expect(ranked).toHaveLength(2);
    expect(ranked[0].url).toBe('https://example.com/coffee');
    expect(ranked[0].affinity).toBeGreaterThan(ranked[1].affinity);
  });

  it('returns zero affinity for all items when the graph has no entities', async () => {
    const items = [item({ title: 'Coffee news', url: 'https://example.com/a' })];
    const ranked = await rankItems(items, []);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].affinity).toBe(0);
  });

  it('collapses near-duplicate items, keeping the highest-affinity representative', async () => {
    const items = [
      item({ title: 'Coffee and espresso trends', url: 'https://example.com/a' }),
      item({ title: 'Coffee and espresso trends', url: 'https://example.com/a-mirror' }), // same text → duplicate
      item({ title: 'Quantum computing breakthrough', url: 'https://example.com/b' })
    ];
    const ranked = await rankItems(items, graphStmts, { duplicateThreshold: 0.99 });
    const urls = ranked.map((r) => r.url);
    // Only one of the two identical-text items should survive.
    expect(urls.filter((u) => u === 'https://example.com/a' || u === 'https://example.com/a-mirror')).toHaveLength(1);
    expect(urls).toContain('https://example.com/b');
  });

  it('drops content-policy-blocked items before ranking', async () => {
    const items = [
      item({ title: 'How to make a bioweapon at home', url: 'https://example.com/blocked' }),
      item({ title: 'Coffee brewing guide', url: 'https://example.com/ok' })
    ];
    const ranked = await rankItems(items, graphStmts);
    expect(ranked.map((r) => r.url)).not.toContain('https://example.com/blocked');
    expect(ranked.map((r) => r.url)).toContain('https://example.com/ok');
  });

  it('respects the limit option', async () => {
    const items = Array.from({ length: 5 }, (_, i) => item({ title: `Item ${i}`, url: `https://example.com/${i}` }));
    const ranked = await rankItems(items, graphStmts, { limit: 2 });
    expect(ranked).toHaveLength(2);
  });

  it('returns [] for an empty item list', async () => {
    expect(await rankItems([], graphStmts)).toEqual([]);
  });
});
