import { describe, it, expect, vi, beforeEach } from 'vitest';
import { labelFromIRI } from '../semantic-diff';

// ── labelFromIRI (pure, no mocking needed) ────────────────────────────────────

describe('labelFromIRI', () => {
  it('extracts slug from urn:kbase:concept/ IRIs', () => {
    expect(labelFromIRI('urn:kbase:concept/matt-roe')).toBe('matt roe');
  });

  it('extracts slug from urn:kbase:predicate/ IRIs', () => {
    expect(labelFromIRI('urn:kbase:predicate/loves')).toBe('loves');
  });

  it('converts hyphens to spaces', () => {
    expect(labelFromIRI('urn:kbase:predicate/is-located-in')).toBe('is located in');
  });

  it('converts underscores to spaces', () => {
    expect(labelFromIRI('urn:kbase:concept/morning_coffee')).toBe('morning coffee');
  });

  it('handles http:// IRIs', () => {
    expect(labelFromIRI('http://example.org/has-name')).toBe('has name');
  });

  it('returns the whole string if no slash present', () => {
    expect(labelFromIRI('loves')).toBe('loves');
  });

  it('trims whitespace', () => {
    expect(labelFromIRI('urn:kbase:concept/alice-').endsWith(' ')).toBe(false);
  });
});

// ── semanticEnrichDiff with mocked embedder ───────────────────────────────────
//
// The embed module loads an ML model (MiniLM-L6-v2) which is unavailable in the
// test environment. We mock $lib/embed to return controlled float vectors so the
// enrichment logic can be tested deterministically.

vi.mock('$lib/embed', () => {
  // Pre-defined "embeddings" keyed by label text.
  // Vectors are designed so:
  //   "matt roe" ≈ "matthew roe"    (cosine ~ 0.97, above 0.88 threshold)
  //   "loves"    ≈ "adores"         (cosine ~ 0.90, above 0.82 threshold)
  //   "supports" ~= "opposes"       (cosine ~ 0.50, within antonym range AND known antonym pair)
  //   "alice"    vs "bob"           (cosine ~ 0.10, unrelated)
  //
  // We fake this with 4-dim unit vectors:

  const VECS: Record<string, number[]> = {
    'matt roe':    [0.99, 0.10, 0.00, 0.00],
    'matthew roe': [0.98, 0.12, 0.00, 0.00],
    'alice':       [0.00, 0.00, 0.99, 0.10],
    'bob':         [0.00, 0.00, 0.10, 0.99],
    'loves':       [0.70, 0.70, 0.10, 0.00],
    'adores':      [0.71, 0.69, 0.11, 0.00],
    'supports':    [0.60, 0.60, 0.50, 0.00],
    'opposes':     [0.58, 0.62, 0.48, 0.02],
    'knows':       [0.50, 0.50, 0.50, 0.50],
    'is-friend-of':[0.51, 0.50, 0.50, 0.49],
  };

  function norm(v: number[]): Float32Array {
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    return new Float32Array(v.map(x => x / mag));
  }

  function getVec(label: string): Float32Array {
    const v = VECS[label.toLowerCase().trim()];
    if (v) return norm(v);
    // Unknown label: return a stable orthogonal-ish vector seeded by string hash
    const seed = label.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) & 0xffff, 0);
    return norm([Math.sin(seed), Math.cos(seed), Math.sin(seed + 1), Math.cos(seed + 1)]);
  }

  return {
    embedMany: (labels: string[]) => Promise.resolve(labels.map(getVec)),
    cosine: (a: Float32Array, b: Float32Array) => {
      let dot = 0;
      for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
      return dot; // already unit vectors
    }
  };
});

// Import AFTER mock is registered
import { semanticEnrichDiff } from '../semantic-diff';
import { computeDiff } from '../diff';
import type { Statement } from '../types';
import { iri, lit } from '../types';

let _id = 0;
function stmt(overrides: Partial<Statement> = {}): Statement {
  return {
    id: `s${++_id}`,
    s: iri('urn:kbase:concept/alice'),
    p: iri('urn:kbase:predicate/knows'),
    o: iri('urn:kbase:concept/bob'),
    g: iri('urn:kbase:source/src1'),
    sourceId: 'src1',
    confidence: 0.8,
    status: 'confirmed',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides
  };
}

describe('semanticEnrichDiff', () => {
  beforeEach(() => { _id = 0; });

  it('returns original diff unchanged when entries is empty', async () => {
    const diff = computeDiff([], []);
    const result = await semanticEnrichDiff(diff, []);
    expect(result.entries).toHaveLength(0);
  });

  it('returns structural diff unchanged when no near-duplicate subjects exist', async () => {
    // "alice" vs "bob" vectors are orthogonal — no semantic overlap
    const existing = stmt({ s: iri('urn:kbase:concept/bob'), p: iri('urn:kbase:predicate/knows'), o: iri('urn:kbase:concept/carol') });
    const incoming = stmt({ id: 'inc', s: iri('urn:kbase:concept/alice'), p: iri('urn:kbase:predicate/loves'), o: lit('something') });
    const structural = computeDiff([incoming], [existing]);
    expect(structural.entries[0].kind).toBe('new');

    const enriched = await semanticEnrichDiff(structural, [existing]);
    // alice vs bob are unrelated — should stay 'new'
    expect(enriched.entries[0].kind).toBe('new');
  });

  it('upgrades new → near-duplicate when subject embeddings are similar', async () => {
    // "matt-roe" vs "matthew-roe" → highly similar vectors
    const existing = stmt({ s: iri('urn:kbase:concept/matthew-roe'), p: iri('urn:kbase:predicate/knows'), o: iri('urn:kbase:concept/alice') });
    const incoming = stmt({ id: 'inc', s: iri('urn:kbase:concept/matt-roe'), p: iri('urn:kbase:predicate/likes'), o: lit('coffee') });

    const structural = computeDiff([incoming], [existing]);
    expect(structural.entries[0].kind).toBe('new');

    const enriched = await semanticEnrichDiff(structural, [existing]);
    expect(enriched.entries[0].kind).toBe('near-duplicate');
    if (enriched.entries[0].kind === 'near-duplicate') {
      expect(enriched.entries[0].subjectSimilarity).toBeGreaterThan(0.88);
    }
  });

  it('upgrades new → synonym-reinforces when subjects similar and predicates synonym', async () => {
    // "matt-roe" ≈ "matthew-roe"; "loves" ≈ "adores"
    const existing = stmt({
      s: iri('urn:kbase:concept/matthew-roe'),
      p: iri('urn:kbase:predicate/loves'),
      o: lit('jazz')
    });
    const incoming = stmt({
      id: 'inc',
      s: iri('urn:kbase:concept/matt-roe'),
      p: iri('urn:kbase:predicate/adores'),
      o: lit('jazz')
    });

    const structural = computeDiff([incoming], [existing]);
    const enriched = await semanticEnrichDiff(structural, [existing]);
    expect(enriched.entries[0].kind).toBe('synonym-reinforces');
    if (enriched.entries[0].kind === 'synonym-reinforces') {
      expect(enriched.entries[0].predicateSimilarity).toBeGreaterThan(0.82);
    }
  });

  it('upgrades new → antonym-conflicts when subjects similar and predicates are antonyms', async () => {
    // "matt-roe" ≈ "matthew-roe"; "supports" vs "opposes" = known antonym pair
    const existing = stmt({
      s: iri('urn:kbase:concept/matthew-roe'),
      p: iri('urn:kbase:predicate/supports'),
      o: iri('urn:kbase:concept/policy-x')
    });
    const incoming = stmt({
      id: 'inc',
      s: iri('urn:kbase:concept/matt-roe'),
      p: iri('urn:kbase:predicate/opposes'),
      o: iri('urn:kbase:concept/policy-x')
    });

    const structural = computeDiff([incoming], [existing]);
    const enriched = await semanticEnrichDiff(structural, [existing]);
    expect(enriched.entries[0].kind).toBe('antonym-conflicts');
    if (enriched.entries[0].kind === 'antonym-conflicts') {
      expect(enriched.entries[0].note).toMatch(/opposes/i);
    }
  });

  it('recounts summary correctly after enrichment', async () => {
    const existing = stmt({ s: iri('urn:kbase:concept/matthew-roe') });
    const incoming = stmt({ id: 'inc', s: iri('urn:kbase:concept/matt-roe') });
    const structural = computeDiff([incoming], [existing]);
    const enriched = await semanticEnrichDiff(structural, [existing]);

    const total =
      enriched.summary.new + enriched.summary.duplicate + enriched.summary.reinforces +
      enriched.summary.conflicts + enriched.summary.refines + enriched.summary.nearDuplicate +
      enriched.summary.synonymReinforces + enriched.summary.antonymConflicts;
    expect(total).toBe(enriched.entries.length);
  });

  it('falls back to structural diff when embedMany throws', async () => {
    // Override mock to throw just for this test
    const { embedMany } = await import('$lib/embed');
    vi.mocked(embedMany).mockRejectedValueOnce(new Error('model unavailable'));

    const existing = stmt({ s: iri('urn:kbase:concept/matthew-roe') });
    const incoming = stmt({ id: 'inc', s: iri('urn:kbase:concept/matt-roe') });
    const structural = computeDiff([incoming], [existing]);

    // Should not throw — falls back to structural
    const result = await semanticEnrichDiff(structural, [existing]);
    expect(result.entries[0].kind).toBe('new'); // structural result preserved
  });

  it('does not alter duplicate or reinforces entries', async () => {
    const existing = stmt({ g: iri('urn:kbase:source/src1') });
    const incDup = stmt({ id: 'dup', g: iri('urn:kbase:source/src1') });
    const incReinforce = stmt({ id: 'rei', g: iri('urn:kbase:source/src2') });

    const structural = computeDiff([incDup, incReinforce], [existing]);
    expect(structural.entries.map(e => e.kind)).toEqual(['duplicate', 'reinforces']);

    const enriched = await semanticEnrichDiff(structural, [existing]);
    expect(enriched.entries.map(e => e.kind)).toEqual(['duplicate', 'reinforces']);
  });
});
