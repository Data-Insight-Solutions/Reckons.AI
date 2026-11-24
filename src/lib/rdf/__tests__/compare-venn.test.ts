/**
 * COMPARE LAYOUT (F306.2) — the mapping the legend and both canvases read.
 *
 * Embeddings are replaced by a deterministic concept table (no model is downloaded): texts in the
 * same group get the same unit vector, every other text gets its own axis. That makes "shared
 * through near-duplicate wording rather than identical text" testable without a network.
 */
import { describe, it, expect } from 'vitest';
import {
  buildCompareModel, computeCompare, findSharedPairs, compareAnchors, compareLegend, vennAnchor,
  resolveCompareColors, DEFAULT_COMPARE_COLORS, VENN,
} from '../compare-venn';
import { termKey, type Statement } from '../types';

const C = 'urn:kbase:concept/';
const P = 'urn:kbase:predicate/';
let n = 0;
const st = (sourceId: string, s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement => ({
  id: `s${n++}`, sourceId, s: { kind: 'iri', value: C + s }, p: { kind: 'iri', value: P + p },
  o: { kind: 'literal', value: o }, g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` },
  confidence: 0.9, status: 'confirmed', createdAt: 0, updatedAt: 0, ...extra,
} as Statement);

const GROUPS = [['thursday', 'thursdays', 'every thursday'], ['members', 'membership'], ['forty', '40']];
function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  const axes = new Map<string, number>();
  const axisOf = (t: string) => {
    const g = GROUPS.findIndex((grp) => grp.includes(t.toLowerCase()));
    const key = g >= 0 ? `g${g}` : `t:${t.toLowerCase()}`;
    if (!axes.has(key)) axes.set(key, axes.size);
    return axes.get(key)!;
  };
  const idx = texts.map(axisOf);
  return Promise.resolve(idx.map((i) => { const v = new Float32Array(Math.max(64, axes.size)); v[i] = 1; return v; }));
}

function fixture() {
  n = 0;
  return [
    st('A', 'co-op', 'press-day', 'Thursday'),        // identical in B
    st('B', 'co-op', 'press-day', 'Thursday'),
    st('A', 'co-op', 'members', 'forty'),             // near-duplicate wording in B
    st('B', 'co-op', 'membership', '40'),
    st('A', 'co-op', 'stores', 'crates'),             // A only
    st('A', 'shed', 'roof', 'slate'),                 // A only, entity touched by nothing else
    st('B', 'co-op', 'founded', '1998'),              // B only
    st('B', 'cellar', 'type', 'stone'),               // B only
    st('C', 'other', 'note', 'outside both'),         // a third provenance
    st('A', 'ghost', 'was', 'rejected', { status: 'rejected' }),
  ];
}

describe('compare mapping', () => {
  it('identical statements only: one shared claim, the rest kept to its own side', () => {
    const m = buildCompareModel(fixture(), 'A', 'B', [['s0', 's1']]);
    expect(m.counts).toEqual({ a: 3, b: 3, shared: 1, sharedStatements: 2, outside: 1 });
    expect(m.statementCategory.get('s0')).toBe('shared');
    expect(m.statementCategory.get('s4')).toBe('a');
    expect(m.statementCategory.get('s6')).toBe('b');
    expect(m.statementCategory.has('s8')).toBe(false); // the third provenance: not drawn in the comparison
    expect(m.statementCategory.has('s9')).toBe(false); // rejected: not a claim
    expect(m.matchedBy).toBe('identical');
  });

  it('findSharedPairs without an embedder finds identical statements only', async () => {
    const { pairs, matchedBy } = await findSharedPairs(fixture(), 'A', 'B');
    expect(pairs).toEqual([['s0', 's1']]);
    expect(matchedBy).toBe('identical');
  });

  it('holds a statement on both sides through near-duplicate wording, not identical text', async () => {
    const { pairs, matchedBy } = await findSharedPairs(fixture(), 'A', 'B', { embedMany: fakeEmbed });
    expect(matchedBy).toBe('meaning');
    expect(pairs).toContainEqual(['s2', 's3']); // members/forty ~ membership/40
    const m = await computeCompare(fixture(), 'A', 'B', { embedMany: fakeEmbed });
    expect(m.counts).toEqual({ a: 2, b: 2, shared: 2, sharedStatements: 4, outside: 1 });
    expect(m.statementCategory.get('s2')).toBe('shared');
    expect(m.statementCategory.get('s3')).toBe('shared');
  });

  it('keeps statements apart whose parts differ by meaning', async () => {
    n = 0;
    const rows = [st('A', 'co-op', 'members', 'forty'), st('B', 'co-op', 'members', 'fifty-two')];
    const m = await computeCompare(rows, 'A', 'B', { embedMany: fakeEmbed });
    expect(m.counts.shared).toBe(0);
    expect(m.counts.a).toBe(1);
    expect(m.counts.b).toBe(1);
  });

  it('never matches a predicate with its antonym', async () => {
    n = 0;
    const rows = [st('A', 'drug', 'safe', 'yes'), st('B', 'drug', 'not-safe', 'yes')];
    const antonymEmbed = (texts: string[]) => Promise.resolve(texts.map((t) => {
      const v = new Float32Array(8); v[t === 'yes' ? 0 : t === 'drug' ? 1 : 2] = 1; return v; // 'safe' and 'not safe' embed identically
    }));
    const m = await computeCompare(rows, 'A', 'B', { embedMany: antonymEmbed });
    expect(m.counts.shared).toBe(0);
  });

  it('merges a claim stated twice by one side into one shared claim', () => {
    n = 0;
    const rows = [st('A', 'x', 'p', 'v'), st('B', 'x', 'p', 'v'), st('B', 'x', 'p', 'v')];
    const m = buildCompareModel(rows, 'A', 'B', [['s0', 's1'], ['s0', 's2']]);
    expect(m.counts.shared).toBe(1);
    expect(m.counts.sharedStatements).toBe(3);
  });

  it('ignores a pair that names a statement outside the comparison', () => {
    const m = buildCompareModel(fixture(), 'A', 'B', [['s4', 's8']]);
    expect(m.counts.shared).toBe(0);
  });
});

describe('entity category rule', () => {
  it('a touched only by A-only is a, only B-only is b, any shared or both lobes is shared', () => {
    const m = buildCompareModel(fixture(), 'A', 'B', [['s0', 's1']]);
    const k = (name: string) => termKey({ kind: 'iri', value: C + name });
    expect(m.entityCategory.get(k('shed'))).toBe('a');
    expect(m.entityCategory.get(k('cellar'))).toBe('b');
    // co-op is touched by a shared statement, an A-only and a B-only one
    expect(m.entityCategory.get(k('co-op'))).toBe('shared');
    // outside the comparison: absent
    expect(m.entityCategory.has(k('other'))).toBe(false);
  });

  it('an entity touched by A-only and B-only statements with nothing shared is still shared', () => {
    n = 0;
    const rows = [st('A', 'x', 'p', '1'), st('B', 'x', 'q', '2')];
    const m = buildCompareModel(rows, 'A', 'B', []);
    expect(m.entityCategory.get(termKey({ kind: 'iri', value: C + 'x' }))).toBe('shared');
  });
});

describe('venn geometry and legend', () => {
  it('puts a-only left of centre, b-only right, shared at the middle of the overlap', () => {
    const m = buildCompareModel(fixture(), 'A', 'B', [['s0', 's1']]);
    const anchors = compareAnchors(m);
    const k = (name: string) => termKey({ kind: 'iri', value: C + name });
    expect(anchors.get(k('shed'))!.x).toBeLessThan(-VENN.OFFSET + 4);
    expect(anchors.get(k('cellar'))!.x).toBeGreaterThan(VENN.OFFSET - 4);
    const shared = anchors.get(k('co-op'))!;
    expect(Math.abs(shared.x)).toBeLessThan(1);
    // the overlap lens lies within both circles
    expect(Math.hypot(shared.x + VENN.OFFSET, shared.y)).toBeLessThan(VENN.RADIUS);
    expect(Math.hypot(shared.x - VENN.OFFSET, shared.y)).toBeLessThan(VENN.RADIUS);
  });

  it('many shared entities stay inside the overlap lens', () => {
    for (let i = 0; i < 40; i++) {
      const p = vennAnchor('shared', i, 40);
      expect(Math.hypot(p.x + VENN.OFFSET, p.y)).toBeLessThan(VENN.RADIUS);
      expect(Math.hypot(p.x - VENN.OFFSET, p.y)).toBeLessThan(VENN.RADIUS);
    }
  });

  it('legend rows carry the model counts and the chosen colours', () => {
    const m = buildCompareModel(fixture(), 'A', 'B', [['s0', 's1']]);
    const rows = compareLegend(m, { a: 'Side A', b: 'Side B' }, DEFAULT_COMPARE_COLORS);
    expect(rows.map((r) => [r.id, r.count])).toEqual([['a', 3], ['shared', 1], ['b', 3]]);
    expect(rows[1].color).toBe(DEFAULT_COMPARE_COLORS.shared);
  });

  it('colours: defaults, partial overrides, and malformed values fall back', () => {
    expect(resolveCompareColors(undefined)).toEqual(DEFAULT_COMPARE_COLORS);
    expect(resolveCompareColors({ a: '#112233' })).toEqual({ ...DEFAULT_COMPARE_COLORS, a: '#112233' });
    expect(resolveCompareColors({ b: 'red', shared: '#xyz' })).toEqual(DEFAULT_COMPARE_COLORS);
  });
});

describe('the comparison fixture (also read by tests/e2e/compare-venn.test.ts)', async () => {
  const { readFileSync } = await import('node:fs');
  const { testEmbedding } = await import('../../embed');
  const fx = JSON.parse(readFileSync('tests/fixtures/compare-venn/comparison.json', 'utf8')) as {
    statements: { source: string; s: string; p: string; o: string; iri?: boolean }[];
    expected: { a: number; b: number; shared: number };
  };
  const rows = (): Statement[] => { n = 0; return fx.statements.map((r) => st(r.source, r.s, r.p, r.o, r.iri ? { o: { kind: 'iri', value: C + r.o } } as Partial<Statement> : {})); };
  const testEmbed = (texts: string[]) => Promise.resolve(texts.map((t) => testEmbedding(t)));

  it('has the documented mapping, with the near-duplicate shared by meaning', async () => {
    const m = await computeCompare(rows(), 'venn-a', 'venn-b', { embedMany: testEmbed });
    expect(m.counts).toMatchObject(fx.expected);
    expect(m.counts.sharedStatements).toBe(6);
  });

  it('string identity alone would miss the near-duplicate', async () => {
    const m = await computeCompare(rows(), 'venn-a', 'venn-b');
    expect(m.counts).toMatchObject({ a: 3, b: 3, shared: 2 });
  });
});
