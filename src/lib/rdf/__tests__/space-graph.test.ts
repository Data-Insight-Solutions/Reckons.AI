import { describe, it, expect } from 'vitest';
import { aggregateEdges, buildSpaceGraph, leapTargetCounts, nodeRadius, edgeWidth, placeLabels, type SpaceInput } from '../space-graph';
import { LEAP_PRED } from '../kb-leap';
import type { Statement } from '../types';

const leap = (target: string, status: Statement['status'] = 'confirmed') =>
  ({ id: target + status, s: { kind: 'iri', value: 'urn:x:node' }, p: { kind: 'iri', value: LEAP_PRED }, o: { kind: 'literal', value: target }, status }) as unknown as Statement;

describe('leapTargetCounts', () => {
  it('counts active space-to-space leaps by target, ignoring app paths, URLs and rejected rows', () => {
    const counts = leapTargetCounts([
      leap('uuid-b'), leap('uuid-b'), leap('uuid-c'),
      leap('/review'), leap('https://example.org'),
      leap('uuid-b', 'rejected'), leap('uuid-c', 'superseded'),
    ]);
    expect(counts).toEqual({ 'uuid-b': 2, 'uuid-c': 1 });
  });
});

const space = (id: string, leapTargets?: Record<string, number>, statementCount = 10): SpaceInput =>
  ({ id, name: id.toUpperCase(), stableId: `uuid-${id}`, statementCount, leapTargets });

describe('aggregateEdges', () => {
  it('makes one edge per pair and keeps the count each way', () => {
    const { edges } = aggregateEdges([space('a', { 'uuid-b': 3 }), space('b', { 'uuid-a': 1 }), space('c', {})]);
    expect(edges).toEqual([{ a: 'a', b: 'b', aToB: 3, bToA: 1, total: 4 }]);
  });

  it('counts leaps to a space that is not registered as unresolved, and ignores a leap to itself', () => {
    const { edges, unresolved } = aggregateEdges([space('a', { 'uuid-gone': 2, 'uuid-a': 5 })]);
    expect(edges).toEqual([]);
    expect(unresolved.get('a')).toBe(2);
  });
});

describe('buildSpaceGraph', () => {
  const sets = [
    { id: 'work', title: 'Work', basis: 'derived', memberIds: ['a', 'b'] },
    { id: 'home', title: 'Home', basis: 'folder', memberIds: ['c'] },
  ];

  it('places every space once, clusters each set, and is the same every time', () => {
    const spaces = [space('a', { 'uuid-c': 1 }), space('b', {}), space('c')];
    const g1 = buildSpaceGraph(spaces, sets);
    const g2 = buildSpaceGraph(spaces, sets);
    expect(g1).toEqual(g2);
    expect(g1.nodes.map((n) => [n.id, n.setId])).toEqual([['a', 'work'], ['b', 'work'], ['c', 'home']]);
    expect(g1.regions.map((r) => [r.id, r.count])).toEqual([['work', 2], ['home', 1]]);
    // Members of one set sit inside that set's region.
    for (const n of g1.nodes) {
      const r = g1.regions.find((x) => x.id === n.setId)!;
      expect(Math.hypot(n.x - r.x, n.y - r.y)).toBeLessThan(r.r);
    }
  });

  it('says how many spaces have not been counted, rather than treating them as having no leaps', () => {
    const g = buildSpaceGraph([space('a', {}), space('b'), space('c')], sets);
    expect(g.uncounted).toBe(2);
    expect(g.nodes.find((n) => n.id === 'b')!.leapsCounted).toBe(false);
    expect(g.nodes.find((n) => n.id === 'a')!.leapsCounted).toBe(true);
  });
});

describe('sizes', () => {
  it('scales nodes by area and caps edge width', () => {
    expect(nodeRadius(0, 100)).toBe(10);
    expect(nodeRadius(100, 100)).toBe(26);
    expect(nodeRadius(25, 100)).toBeCloseTo(18);
    expect(edgeWidth(1)).toBe(3);
    expect(edgeWidth(10_000)).toBe(9);
  });
});

describe('pools never overlap', () => {
  it('grows the drawing so neighbouring sets keep their distance, for 2 to 7 sets', () => {
    for (let n = 2; n <= 7; n++) {
      const sets = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: `Set ${i}`, basis: 'derived', memberIds: [`a${i}`, `b${i}`, `c${i}`] }));
      const spaces = sets.flatMap((s) => s.memberIds.map((id) => ({ id, name: id, statementCount: 100 })));
      const g = buildSpaceGraph(spaces, sets);
      for (let i = 0; i < g.regions.length; i++) {
        for (let j = i + 1; j < g.regions.length; j++) {
          const a = g.regions[i], b = g.regions[j];
          expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThanOrEqual(a.r + b.r);
        }
        const r = g.regions[i];
        expect(r.x - r.r).toBeGreaterThanOrEqual(0);
        expect(r.y - r.r - 20).toBeGreaterThanOrEqual(0); // room for the title above the pool
      }
    }
  });
});

describe('placeLabels', () => {
  const crowd = (n: number) => {
    const ids = Array.from({ length: n }, (_, i) => `space-with-a-longish-name-${i}`);
    return buildSpaceGraph(ids.map((id, i) => ({ id, name: id, statementCount: 10 + i })), [{ id: 'u', title: 'Ungrouped', basis: 'ungrouped', memberIds: ids }]);
  };
  it('shows no two labels that overlap and none that leave the frame, in a crowded pool', () => {
    const g = crowd(12);
    const labels = placeLabels(g).filter((l) => l.shown);
    expect(labels.length).toBeGreaterThan(0);
    const box = (l: (typeof labels)[number]) => {
      const w = l.text.length * l.fontSize * 0.56;
      const x1 = l.anchor === 'start' ? l.x : l.anchor === 'end' ? l.x - w : l.x - w / 2;
      return { x1, x2: x1 + w, y1: l.y - l.fontSize, y2: l.y + l.fontSize * 0.25 };
    };
    for (const l of labels) { const b = box(l); expect(b.x1).toBeGreaterThanOrEqual(0); expect(b.x2).toBeLessThanOrEqual(g.width); }
    for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
      const a = box(labels[i]), b = box(labels[j]);
      expect(a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1).toBe(false);
    }
  });
  it('always shows the selected and current spaces, and truncates long names', () => {
    const g = crowd(12);
    const pick = g.nodes[5].id, current = g.nodes[9].id;
    const labels = placeLabels(g, { selectedId: pick, currentId: current });
    expect(labels.find((l) => l.id === pick)!.shown).toBe(true);
    expect(labels.find((l) => l.id === current)!.shown).toBe(true);
    expect(labels.every((l) => l.text.length <= 18)).toBe(true);
  });
});
