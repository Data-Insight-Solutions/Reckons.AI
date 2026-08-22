/**
 * Hierarchy layout — sub-trees must be visibly SEPARATE, not one undifferentiated ring.
 *
 * Matt, 2026-08-21: "we should separate the dependency sub-trees radially with some space."
 * The old allocation centred each group's sector on its parent's angle and filled the circle
 * exactly, so two parents at similar angles got overlapping sectors and adjacent branches ran edge
 * to edge with no visual break.
 */
import { describe, it, expect } from 'vitest';
import { buildHierarchyAnchors, SKOS_BROADER } from '../hierarchy';
import type { Statement } from '../types';

let n = 0;
const st = (s: string, p: string, o: string): Statement => {
  n += 1;
  return {
    id: `s${n}`, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p },
    o: { kind: 'iri', value: o }, g: { kind: 'iri', value: 'urn:g' },
    sourceId: 'x', confidence: 1, status: 'pending', createdAt: n, updatedAt: n,
  } as Statement;
};
const K = (iri: string) => `i:${iri}`;
const C = 'urn:kbase:concept/';

/** Angle of a placed node about its own level's centre. */
const angleOf = (a: Map<string, { x: number; y: number }>, iri: string, levelY: number) => {
  const p = a.get(K(iri))!;
  return Math.atan2(p.y - levelY, p.x);
};

describe('sub-trees get their own sector, with space between them', () => {
  // One root, two branches, three leaves each.
  const stmts: Statement[] = [
    st(`${C}a`, SKOS_BROADER, `${C}root`),
    st(`${C}b`, SKOS_BROADER, `${C}root`),
    ...['a1', 'a2', 'a3'].map((c) => st(`${C}${c}`, SKOS_BROADER, `${C}a`)),
    ...['b1', 'b2', 'b3'].map((c) => st(`${C}${c}`, SKOS_BROADER, `${C}b`)),
  ];
  const iris = [...new Set(stmts.flatMap((s) => [s.s.value, s.o.value]))];
  const nodes = iris.map((iri) => ({ key: K(iri) }));
  const anchors = buildHierarchyAnchors(stmts, nodes, []);

  it('places every node in the stated hierarchy', () => {
    for (const iri of iris) expect(anchors.has(K(iri)), `${iri} unplaced`).toBe(true);
  });

  it('keeps each branch CONTIGUOUS and leaves a gap to the next one', () => {
    /*
     * The RING CENTRE of depth 2 — not a node's own y, which carries its own r*sin(theta) and
     * would collapse every angle on the level to 0 or pi.
     *
     * The tree is centred on the origin (fixed 2026-08-21 so it no longer renders below the
     * viewport centre), so a level sits at `depth * LEVEL_DROP - (maxDepth * LEVEL_DROP) / 2`.
     * Here that is 2*9 - (2*9)/2 = 9.
     */
    const levelY = 9;
    const aAngles = ['a1', 'a2', 'a3'].map((c) => angleOf(anchors, `${C}${c}`, levelY)).sort((x, y) => x - y);
    const bAngles = ['b1', 'b2', 'b3'].map((c) => angleOf(anchors, `${C}${c}`, levelY)).sort((x, y) => x - y);

    // No interleaving: one branch's children all sit to one side of the other's.
    const aMax = Math.max(...aAngles), aMin = Math.min(...aAngles);
    const bMax = Math.max(...bAngles), bMin = Math.min(...bAngles);
    expect(aMax < bMin || bMax < aMin, 'branches interleaved instead of occupying separate arcs').toBe(true);

    // And the space BETWEEN the branches exceeds the spacing WITHIN one — which is what makes the
    // split readable rather than merely present.
    const within = Math.max(aAngles[1] - aAngles[0], bAngles[1] - bAngles[0]);
    const between = aMax < bMin ? bMin - aMax : aMin - bMax;
    expect(between).toBeGreaterThan(within);
  });

  it('separates two SINGLE-child branches, which used to land on the same angle', () => {
    // The old code pinned a lone child to its parent's exact angle, so two only-children of
    // similarly-placed parents were drawn on top of one another.
    const two: Statement[] = [
      st(`${C}p`, SKOS_BROADER, `${C}r`),
      st(`${C}q`, SKOS_BROADER, `${C}r`),
      st(`${C}p1`, SKOS_BROADER, `${C}p`),
      st(`${C}q1`, SKOS_BROADER, `${C}q`),
    ];
    const ir = [...new Set(two.flatMap((s) => [s.s.value, s.o.value]))];
    const a = buildHierarchyAnchors(two, ir.map((i) => ({ key: K(i) })), []);
    const p1 = a.get(K(`${C}p1`))!, q1 = a.get(K(`${C}q1`))!;
    const dist = Math.hypot(p1.x - q1.x, p1.y - q1.y);
    expect(dist, 'two only-children drawn on top of each other').toBeGreaterThan(1);
  });

  it('does not let gaps swallow the circle when there are many branches', () => {
    // With one branch per node the padding must not dominate: every child still gets real arc.
    const many: Statement[] = [];
    for (let i = 0; i < 12; i++) {
      many.push(st(`${C}p${i}`, SKOS_BROADER, `${C}root`));
      many.push(st(`${C}c${i}`, SKOS_BROADER, `${C}p${i}`));
    }
    const ir = [...new Set(many.flatMap((s) => [s.s.value, s.o.value]))];
    const a = buildHierarchyAnchors(many, ir.map((i) => ({ key: K(i) })), []);
    const placed = Array.from({ length: 12 }, (_, i) => a.get(K(`${C}c${i}`))).filter(Boolean);
    expect(placed).toHaveLength(12);
    const uniq = new Set(placed.map((p) => `${p!.x.toFixed(2)},${p!.y.toFixed(2)}`));
    expect(uniq.size, 'children collapsed onto shared positions').toBe(12);
  });
});

describe('orientation and framing — the two things a user sees first', () => {
  // root → two branches → two leaves each: three levels, so both properties are non-trivial.
  const stmts: Statement[] = [
    st(`${C}b1`, SKOS_BROADER, `${C}root`),
    st(`${C}b2`, SKOS_BROADER, `${C}root`),
    st(`${C}l1`, SKOS_BROADER, `${C}b1`),
    st(`${C}l2`, SKOS_BROADER, `${C}b1`),
    st(`${C}l3`, SKOS_BROADER, `${C}b2`),
    st(`${C}l4`, SKOS_BROADER, `${C}b2`),
  ];
  const iris = [...new Set(stmts.flatMap((s) => [s.s.value, s.o.value]))];
  const anchors = buildHierarchyAnchors(stmts, iris.map((i) => ({ key: K(i) })), []);

  it('puts the ROOT at the highest level, not one down', () => {
    /*
     * Matt, 2026-08-21: "the 'root' was down a level and not at highest level."
     *
     * These anchors feed the 2D renderer only, and its worldToScreen does NOT flip y — canvas y
     * grows downward. Levels were placed at `-d * LEVEL_DROP`, correct for the y-up 3D twin and
     * upside down here, so the root sat at the BOTTOM with its descendants climbing above it.
     */
    const rootY = anchors.get(K(`${C}root`))!.y;
    const everyoneElse = ['b1', 'b2', 'l1', 'l2', 'l3', 'l4'].map((n) => anchors.get(K(`${C}${n}`))!.y);
    for (const y of everyoneElse) expect(rootY).toBeLessThan(y);
    // And depth is monotonic: a leaf is below its branch, which is below the root.
    expect(anchors.get(K(`${C}b1`))!.y).toBeLessThan(anchors.get(K(`${C}l1`))!.y);
  });

  it('CENTRES the tree on the origin, so it does not render below the viewport', () => {
    /*
     * Matt: "the graph appears below the central focus of the screen and I needed to manually drag
     * each load." Levels ran 0 -> -(maxDepth * LEVEL_DROP), so the centroid sat half the tree's
     * height from the origin the camera frames.
     */
    const ys = [...anchors.values()].map((a) => a.y);
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
    const span = Math.max(...ys) - Math.min(...ys);
    // The tree's vertical midpoint is at the origin, within a fraction of one level.
    expect(Math.abs(mid)).toBeLessThan(span * 0.15);
  });
});
