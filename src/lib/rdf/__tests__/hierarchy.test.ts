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
    expect(root.y).toBe(0);

    // Children should be in a ring (non-zero distance from center)
    const c1 = anchors.get('i:urn:child1')!;
    const c2 = anchors.get('i:urn:child2')!;
    expect(Math.hypot(c1.x, c1.y)).toBeGreaterThan(1);
    expect(Math.hypot(c2.x, c2.y)).toBeGreaterThan(1);
  });

  it('returns empty map when no broader relationships exist', () => {
    const nodes = [{ key: 'i:urn:solo' }];
    const anchors = buildHierarchyAnchors([], nodes, []);
    expect(anchors.size).toBe(0);
  });
});
