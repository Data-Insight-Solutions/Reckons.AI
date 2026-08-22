import { describe, it, expect } from 'vitest';
import { buildHierarchy, getOrderedChildren, getSiblingNav, buildHierarchyAnchors, NAV_ORDER, NAV_NEXT, NAV_PREV, NAV_LAYER, SKOS_BROADER } from '../hierarchy';
import type { Statement } from '../types';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function mkStmt(s: string, p: string, o: string, oKind: 'iri' | 'literal' = 'iri'): Statement {
  return {
    id: `${s}-${p.split('/').pop()}-${o}`,
    s: { kind: 'iri', value: s },
    p: { kind: 'iri', value: p },
    o: { kind: oKind, value: o },
    g: { kind: 'iri', value: 'urn:test' },
    sourceId: 'test',
    status: 'confirmed',
    confidence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe('buildHierarchy', () => {
  it('builds a two-level tree from broader relationships', () => {
    const stmts: Statement[] = [
      mkStmt('urn:child1', SKOS_BROADER, 'urn:root'),
      mkStmt('urn:child2', SKOS_BROADER, 'urn:root'),
      mkStmt('urn:root', RDFS_LABEL, 'Root', 'literal'),
      mkStmt('urn:child1', RDFS_LABEL, 'Child 1', 'literal'),
      mkStmt('urn:child2', RDFS_LABEL, 'Child 2', 'literal'),
      mkStmt('urn:child1', NAV_ORDER, '1', 'literal'),
      mkStmt('urn:child2', NAV_ORDER, '2', 'literal'),
    ];
    const roots = buildHierarchy(stmts);
    expect(roots.length).toBe(1);
    expect(roots[0].iri).toBe('urn:root');
    expect(roots[0].label).toBe('Root');
    expect(roots[0].children.length).toBe(2);
    expect(roots[0].children[0].label).toBe('Child 1');
    expect(roots[0].children[0].order).toBe(1);
    expect(roots[0].children[1].label).toBe('Child 2');
    expect(roots[0].children[1].order).toBe(2);
  });

  it('auto-computes layers: root highest, leaves 0', () => {
    const stmts: Statement[] = [
      mkStmt('urn:leaf', SKOS_BROADER, 'urn:mid'),
      mkStmt('urn:mid', SKOS_BROADER, 'urn:root'),
    ];
    const roots = buildHierarchy(stmts);
    expect(roots[0].layer).toBe(2); // root = highest
    expect(roots[0].children[0].layer).toBe(1); // mid
    expect(roots[0].children[0].children[0].layer).toBe(0); // leaf
  });

  it('respects explicit nav:layer', () => {
    const stmts: Statement[] = [
      mkStmt('urn:child', SKOS_BROADER, 'urn:root'),
      mkStmt('urn:root', NAV_LAYER, '5', 'literal'),
      mkStmt('urn:child', NAV_LAYER, '3', 'literal'),
    ];
    const roots = buildHierarchy(stmts);
    expect(roots[0].layer).toBe(5);
    expect(roots[0].children[0].layer).toBe(3);
  });

  it('picks up nav:next and nav:prev', () => {
    const stmts: Statement[] = [
      mkStmt('urn:a', SKOS_BROADER, 'urn:root'),
      mkStmt('urn:b', SKOS_BROADER, 'urn:root'),
      mkStmt('urn:a', NAV_NEXT, 'urn:b'),
      mkStmt('urn:b', NAV_PREV, 'urn:a'),
    ];
    const roots = buildHierarchy(stmts);
    const a = roots[0].children.find(c => c.iri === 'urn:a')!;
    const b = roots[0].children.find(c => c.iri === 'urn:b')!;
    expect(a.next).toBe('urn:b');
    expect(b.prev).toBe('urn:a');
  });

  it('excludes rejected statements', () => {
    const stmts: Statement[] = [
      mkStmt('urn:child', SKOS_BROADER, 'urn:root'),
    ];
    stmts[0].status = 'rejected';
    const roots = buildHierarchy(stmts);
    expect(roots.length).toBe(0);
  });
});

describe('getOrderedChildren', () => {
  it('returns children sorted by nav:order', () => {
    const stmts: Statement[] = [
      mkStmt('urn:c', SKOS_BROADER, 'urn:parent'),
      mkStmt('urn:a', SKOS_BROADER, 'urn:parent'),
      mkStmt('urn:b', SKOS_BROADER, 'urn:parent'),
      mkStmt('urn:a', NAV_ORDER, '1', 'literal'),
      mkStmt('urn:b', NAV_ORDER, '2', 'literal'),
      mkStmt('urn:c', NAV_ORDER, '3', 'literal'),
      mkStmt('urn:a', RDFS_LABEL, 'Alpha', 'literal'),
      mkStmt('urn:b', RDFS_LABEL, 'Beta', 'literal'),
      mkStmt('urn:c', RDFS_LABEL, 'Charlie', 'literal'),
    ];
    const children = getOrderedChildren(stmts, 'urn:parent');
    expect(children.map(c => c.label)).toEqual(['Alpha', 'Beta', 'Charlie']);
    expect(children.map(c => c.order)).toEqual([1, 2, 3]);
  });
});

describe('getSiblingNav', () => {
  it('returns next/prev IRIs', () => {
    const stmts: Statement[] = [
      mkStmt('urn:mid', NAV_NEXT, 'urn:right'),
      mkStmt('urn:mid', NAV_PREV, 'urn:left'),
    ];
    const nav = getSiblingNav(stmts, 'urn:mid');
    expect(nav.next).toBe('urn:right');
    expect(nav.prev).toBe('urn:left');
  });

  it('returns null when no siblings', () => {
    const nav = getSiblingNav([], 'urn:solo');
    expect(nav.next).toBeNull();
    expect(nav.prev).toBeNull();
  });
});

describe('buildHierarchyAnchors', () => {
  it('places root at center and children in outer ring', () => {
    const stmts: Statement[] = [
      mkStmt('urn:child1', SKOS_BROADER, 'urn:root'),
      mkStmt('urn:child2', SKOS_BROADER, 'urn:root'),
    ];
    const nodes = [
      { key: 'i:urn:root' },
      { key: 'i:urn:child1' },
      { key: 'i:urn:child2' },
    ];
    const anchors = buildHierarchyAnchors(stmts, nodes, []);
    expect(anchors.has('i:urn:root')).toBe(true);
    expect(anchors.has('i:urn:child1')).toBe(true);
    expect(anchors.has('i:urn:child2')).toBe(true);

    const root = anchors.get('i:urn:root')!;
    expect(root.x).toBe(0);
    // The tree is CENTRED on the origin, so a root is only at y:0 when the tree is one level
    // deep — what must hold at every depth is that the root is above its children.
    expect(root.y).toBeLessThan(anchors.get('i:urn:child1')!.y);

    /*
     * Children sit in a RING — measured from their own level's centre, not from the origin.
     * Centring the tree moved the origin into the middle of it, so distance-from-origin now says
     * how far a node is from the middle of the WHOLE TREE, which is not what "in a ring" means:
     * a child directly below the centre legitimately lands near the origin.
     */
    const c1 = anchors.get('i:urn:child1')!;
    const c2 = anchors.get('i:urn:child2')!;
    const levelY = (c1.y + c2.y) / 2;
    expect(Math.hypot(c1.x, c1.y - levelY)).toBeGreaterThan(1);
    expect(Math.hypot(c2.x, c2.y - levelY)).toBeGreaterThan(1);
  });

  it('returns empty map when no broader relationships exist', () => {
    const nodes = [{ key: 'i:urn:solo' }];
    const anchors = buildHierarchyAnchors([], nodes, []);
    expect(anchors.size).toBe(0);
  });
});

describe('buildHierarchyAnchors — depends-on, laid out as stacked levels', () => {
  const KPRED_DEPENDS_ON = 'urn:kbase:predicate/depends-on';
  const nodesFor = (...iris: string[]) => iris.map((i) => ({ key: `i:${i}` }));
  /** Which level a node landed on. Levels descend, so deeper == more negative y. */
  /*
   * DEPTH IN SCREEN SPACE, and the sign matters.
   *
   * These anchors feed the 2D renderer ONLY (the 3D twin has its own buildHierarchyAnchors3D),
   * and KnowledgeGraph2D's worldToScreen does not flip y — canvas y grows DOWNWARD. These tests
   * previously encoded y-UP semantics (root at y:0, children at -1), which read correctly as
   * intent and drew the tree UPSIDE DOWN: the root sat at the bottom with its descendants
   * climbing above it. Fixed 2026-08-21 after Matt reported "the 'root' was down a level and not
   * at highest level".
   *
   * So: deeper = LARGER y = further down the screen. And the whole tree is CENTRED on the origin,
   * so a root is only at y:0 when the tree is one level deep.
   */
  const levelOf = (a: { x: number; y: number }) => Math.round(a.y / 9);
  /** Depth relative to the shallowest placed node — sign-independent, so it survives centring. */
  const depthFrom = (root: { y: number }, node: { y: number }) => Math.round((node.y - root.y) / 9);

  it('puts the prerequisite on the level ABOVE the features that need it', () => {
    const stmts = [
      mkStmt('urn:f81', KPRED_DEPENDS_ON, 'urn:f80'),
      mkStmt('urn:f82', KPRED_DEPENDS_ON, 'urn:f80'),
    ];
    const anchors = buildHierarchyAnchors(stmts, nodesFor('urn:f80', 'urn:f81', 'urn:f82'), []);

    expect(anchors.size).toBe(3);
    const root = anchors.get('i:urn:f80')!;
    // A lone root sits at the centre of the top circle: x centred, and ABOVE its dependents.
    expect(root.x).toBe(0);
    // Both dependents share the next level DOWN THE SCREEN — one circle, one level.
    expect(depthFrom(root, anchors.get('i:urn:f81')!)).toBe(1);
    expect(depthFrom(root, anchors.get('i:urn:f82')!)).toBe(1);
    expect(anchors.get('i:urn:f81')!.y).toBeGreaterThan(root.y);
    expect(anchors.get('i:urn:f81')!.y).toBeGreaterThan(anchors.get('i:urn:f80')!.y);
  });

  it('drops a third level below the second — depth is the vertical axis', () => {
    const stmts = [
      mkStmt('urn:mid', KPRED_DEPENDS_ON, 'urn:root'),
      mkStmt('urn:leaf', KPRED_DEPENDS_ON, 'urn:mid'),
    ];
    const anchors = buildHierarchyAnchors(stmts, nodesFor('urn:root', 'urn:mid', 'urn:leaf'), []);
    const root = anchors.get('i:urn:root')!;
    // Each level is strictly further DOWN the screen than the one above it.
    expect(depthFrom(root, anchors.get('i:urn:mid')!)).toBe(1);
    expect(depthFrom(root, anchors.get('i:urn:leaf')!)).toBe(2);
    expect(root.y).toBeLessThan(anchors.get('i:urn:mid')!.y);
    expect(anchors.get('i:urn:mid')!.y).toBeLessThan(anchors.get('i:urn:leaf')!.y);
  });

  it('does not invert the tree — the dependent never becomes the root', () => {
    const stmts = [mkStmt('urn:dependent', KPRED_DEPENDS_ON, 'urn:prerequisite')];
    const anchors = buildHierarchyAnchors(stmts, nodesFor('urn:prerequisite', 'urn:dependent'), []);
    expect(anchors.get('i:urn:dependent')!.y).toBeGreaterThan(anchors.get('i:urn:prerequisite')!.y);
  });

  it('lets an explicit skos:broader win over an inferred depends-on parent', () => {
    const stmts = [
      mkStmt('urn:x', KPRED_DEPENDS_ON, 'urn:prereq'),
      mkStmt('urn:x', SKOS_BROADER, 'urn:taxonomy'),
    ];
    const anchors = buildHierarchyAnchors(stmts, nodesFor('urn:prereq', 'urn:taxonomy', 'urn:x'), []);
    // The taxonomic parent is the one x hangs under: it sits ABOVE x on screen, one level up.
    const tax = anchors.get('i:urn:taxonomy')!;
    expect(tax.y).toBeLessThan(anchors.get('i:urn:x')!.y);
    expect(depthFrom(tax, anchors.get('i:urn:x')!)).toBe(1);
  });

  it('parks nodes with no stated parent below the tree, not as its deepest branch', () => {
    const stmts = [mkStmt('urn:child', KPRED_DEPENDS_ON, 'urn:root')];
    const anchors = buildHierarchyAnchors(stmts, nodesFor('urn:root', 'urn:child', 'urn:loner'), []);
    // Strictly below the deepest real level, so it never reads as a descendant of it.
    // Below = LARGER y, because this layout is drawn in screen space.
    expect(anchors.get('i:urn:loner')!.y).toBeGreaterThan(anchors.get('i:urn:child')!.y);
  });

  it('still returns nothing when the graph states no hierarchy at all', () => {
    const stmts = [mkStmt('urn:a', 'urn:kbase:predicate/mentions', 'urn:b')];
    expect(buildHierarchyAnchors(stmts, nodesFor('urn:a', 'urn:b'), []).size).toBe(0);
  });
});

describe('buildHierarchyAnchors — unplaced nodes stay bounded', () => {
  const KPRED_DEPENDS_ON = 'urn:kbase:predicate/depends-on';

  it('does not scale the orphan area with node count', () => {
    // The regression: one ring sized by population. 600 unplaced nodes produced a radius of ~700
    // against level rings of 7-20, so the force simulation had to settle bodies across a hundred
    // times the useful area — which presents as a frozen graph rather than an ugly one.
    const stmts = [mkStmt('urn:child', KPRED_DEPENDS_ON, 'urn:root')];
    const nodes = [
      { key: 'i:urn:root' },
      { key: 'i:urn:child' },
      ...Array.from({ length: 600 }, (_, i) => ({ key: `i:urn:orphan${i}` })),
    ];
    const anchors = buildHierarchyAnchors(stmts, nodes, []);

    const radii = [...anchors.entries()]
      .filter(([k]) => k.includes('orphan'))
      .map(([, a]) => Math.hypot(a.x, a.y));

    expect(radii).toHaveLength(600);
    // Comfortably bounded: linear scaling would put this near 700.
    expect(Math.max(...radii)).toBeLessThan(200);
  });

  it('keeps the tree and the orphans within the same order of size', () => {
    const stmts = [mkStmt('urn:child', KPRED_DEPENDS_ON, 'urn:root')];
    const nodes = [
      { key: 'i:urn:root' },
      { key: 'i:urn:child' },
      ...Array.from({ length: 200 }, (_, i) => ({ key: `i:urn:o${i}` })),
    ];
    const anchors = buildHierarchyAnchors(stmts, nodes, []);
    /*
     * Measured as EXTENT from the tree's own centre, not as distance from the origin. Centring
     * moved the origin into the middle of the tree, so a root that used to sit at hypot 0 now
     * sits half a level away — and a ratio with that in the denominator says nothing about
     * whether the orphan ring is proportionate.
     */
    const tree = [anchors.get('i:urn:root')!, anchors.get('i:urn:child')!];
    const cy = (tree[0].y + tree[1].y) / 2;
    const orphanMax = Math.max(
      ...[...anchors.entries()].filter(([k]) => k.includes(':urn:o')).map(([, a]) => Math.hypot(a.x, a.y - cy)),
    );
    // The tree's SPAN, not one node's distance from a centre that sits inside it. Centring halved
    // the latter and would have doubled this ratio without the orphan ring changing at all.
    const treeMax = Math.abs(tree[1].y - tree[0].y);
    expect(orphanMax / treeMax).toBeLessThan(12);
  });
});
