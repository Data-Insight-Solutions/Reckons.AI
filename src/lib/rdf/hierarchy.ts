/**
 * Hierarchy navigation — HNSW-inspired layered graph traversal.
 *
 * Maps HNSW concepts to knowledge graph navigation:
 *
 *   HNSW Layer N (sparse)  →  Hub KB with leap nodes (long-range links)
 *   HNSW Layer 1 (medium)  →  Sub-KB topic clusters (skos:broader trees)
 *   HNSW Layer 0 (dense)   →  Individual entities / story steps
 *
 *   Long-range links       →  urn:reckons:leap (cross-KB jumps)
 *   Short-range links      →  skos:broader / skos:related (intra-KB)
 *   Entry point            →  Hub entity with highest in-degree
 *   Greedy descent          →  Click leap → enter sub-KB → browse broader tree
 *   Sibling traversal      →  nav:next / nav:prev between sub-KBs at same layer
 *
 * Predicates used:
 *   nav:order    — integer position within a parent's children (like story:order)
 *   nav:next     — IRI of the next sibling sub-KB (for horizontal traversal)
 *   nav:prev     — IRI of the previous sibling sub-KB
 *   nav:layer    — HNSW-style layer depth (0 = detail, higher = sparser overview)
 */

import type { Statement } from './types';

export const SKOS_BROADER  = 'http://www.w3.org/2004/02/skos/core#broader';
export const SKOS_NARROWER = 'http://www.w3.org/2004/02/skos/core#narrower';
export const SKOS_RELATED  = 'http://www.w3.org/2004/02/skos/core#related';

export const NAV_NS     = 'urn:reckons:nav/';
export const NAV_ORDER  = `${NAV_NS}order`;
export const NAV_NEXT   = `${NAV_NS}next`;
export const NAV_PREV   = `${NAV_NS}prev`;
export const NAV_LAYER  = `${NAV_NS}layer`;

const RDF_TYPE   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

function isActive(s: Statement) {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

export interface HierarchyNode {
  iri: string;
  label: string;
  layer: number;
  order: number;
  children: HierarchyNode[];
  parent: string | null;
  next: string | null;
  prev: string | null;
}

/**
 * Build a hierarchy tree from statements using skos:broader relationships.
 * Returns root nodes (entities with no broader parent).
 */
export function buildHierarchy(stmts: Statement[]): HierarchyNode[] {
  const active = stmts.filter(isActive);

  // Collect labels
  const labels = new Map<string, string>();
  for (const s of active) {
    if (s.p.value === RDFS_LABEL && s.s.kind === 'iri' && s.o.kind === 'literal') {
      labels.set(s.s.value, s.o.value);
    }
  }

  // Build parent → children map from skos:broader (child broader parent)
  const parentOf = new Map<string, string>(); // child → parent
  const childrenOf = new Map<string, string[]>(); // parent → [children]

  for (const s of active) {
    if (s.p.value === SKOS_BROADER && s.s.kind === 'iri' && s.o.kind === 'iri') {
      const child = s.s.value;
      const parent = s.o.value;
      parentOf.set(child, parent);
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent)!.push(child);
    }
  }

  // Collect nav:order values
  const orderOf = new Map<string, number>();
  for (const s of active) {
    if (s.p.value === NAV_ORDER && s.s.kind === 'iri' && s.o.kind === 'literal') {
      orderOf.set(s.s.value, parseInt(s.o.value, 10));
    }
  }

  // Collect nav:next / nav:prev
  const nextOf = new Map<string, string>();
  const prevOf = new Map<string, string>();
  for (const s of active) {
    if (s.s.kind !== 'iri' || s.o.kind !== 'iri') continue;
    if (s.p.value === NAV_NEXT) nextOf.set(s.s.value, s.o.value);
    if (s.p.value === NAV_PREV) prevOf.set(s.s.value, s.o.value);
  }

  // Collect explicit nav:layer
  const layerOf = new Map<string, number>();
  for (const s of active) {
    if (s.p.value === NAV_LAYER && s.s.kind === 'iri' && s.o.kind === 'literal') {
      layerOf.set(s.s.value, parseInt(s.o.value, 10));
    }
  }

  // Collect all entity IRIs that participate in broader relationships
  const allIris = new Set<string>();
  for (const [child, parent] of parentOf) {
    allIris.add(child);
    allIris.add(parent);
  }

  // Find roots (entities that have children but no parent in the broader tree)
  const rootIris = [...allIris].filter(iri => !parentOf.has(iri) && (childrenOf.has(iri) || layerOf.has(iri)));

  // Compute max tree depth from each root for auto-layer assignment
  function getMaxDepth(iri: string, visited = new Set<string>()): number {
    if (visited.has(iri)) return 0;
    visited.add(iri);
    const children = childrenOf.get(iri) ?? [];
    if (children.length === 0) return 0;
    return 1 + Math.max(...children.map(c => getMaxDepth(c, visited)));
  }

  // Pre-compute total tree depth for each root
  const rootMaxDepth = new Map<string, number>();
  for (const root of rootIris) {
    rootMaxDepth.set(root, getMaxDepth(root));
  }

  // Find which root an IRI belongs to
  function findRoot(iri: string): string | null {
    let cur = iri;
    while (parentOf.has(cur)) cur = parentOf.get(cur)!;
    return rootIris.includes(cur) ? cur : null;
  }

  // Build tree recursively
  function buildNode(iri: string, depth: number, treeDepth: number): HierarchyNode {
    const children = (childrenOf.get(iri) ?? [])
      .map(c => buildNode(c, depth + 1, treeDepth))
      .sort((a, b) => a.order - b.order);

    return {
      iri,
      label: labels.get(iri) ?? iri.split('/').pop() ?? iri,
      layer: layerOf.get(iri) ?? (treeDepth - depth),
      order: orderOf.get(iri) ?? 0,
      children,
      parent: parentOf.get(iri) ?? null,
      next: nextOf.get(iri) ?? null,
      prev: prevOf.get(iri) ?? null,
    };
  }

  const roots = rootIris
    .map(iri => buildNode(iri, 0, rootMaxDepth.get(iri) ?? 0))
    .sort((a, b) => a.order - b.order);

  return roots;
}

/**
 * Get the ordered children of a given entity IRI, sorted by nav:order.
 * Useful for rendering sub-navigation within a node panel.
 */
export function getOrderedChildren(stmts: Statement[], parentIri: string): Array<{ iri: string; label: string; order: number }> {
  const active = stmts.filter(isActive);
  const children: Array<{ iri: string; label: string; order: number }> = [];

  // Find children via skos:broader (child broader parent)
  const childIris = new Set<string>();
  for (const s of active) {
    if (s.p.value === SKOS_BROADER && s.o.kind === 'iri' && s.o.value === parentIri && s.s.kind === 'iri') {
      childIris.add(s.s.value);
    }
  }

  // Collect labels and orders
  const labels = new Map<string, string>();
  const orders = new Map<string, number>();
  for (const s of active) {
    if (s.s.kind !== 'iri' || !childIris.has(s.s.value)) continue;
    if (s.p.value === RDFS_LABEL && s.o.kind === 'literal') labels.set(s.s.value, s.o.value);
    if (s.p.value === NAV_ORDER && s.o.kind === 'literal') orders.set(s.s.value, parseInt(s.o.value, 10));
  }

  for (const iri of childIris) {
    children.push({
      iri,
      label: labels.get(iri) ?? iri.split('/').pop() ?? iri,
      order: orders.get(iri) ?? 0,
    });
  }

  return children.sort((a, b) => a.order - b.order);
}

/**
 * Get sibling navigation for cross-KB traversal.
 * Returns next/prev KB stable IDs for horizontal HNSW-style movement.
 */
export function getSiblingNav(stmts: Statement[], entityIri: string): { next: string | null; prev: string | null } {
  const active = stmts.filter(isActive);
  let next: string | null = null;
  let prev: string | null = null;

  for (const s of active) {
    if (s.s.kind !== 'iri' || s.s.value !== entityIri) continue;
    if (s.p.value === NAV_NEXT && s.o.kind === 'iri') next = s.o.value;
    if (s.p.value === NAV_PREV && s.o.kind === 'iri') prev = s.o.value;
  }

  return { next, prev };
}

/**
 * Compute HNSW-style anchor positions for a hierarchy layout.
 * Roots at center (highest layer), children in concentric rings.
 * Within each ring, nodes are ordered by nav:order, then alphabetically.
 */
export function buildHierarchyAnchors(
  stmts: Statement[],
  nodes: Array<{ key: string }>,
  edges: Array<{ a: { key: string }; b: { key: string } }>
): Map<string, { x: number; y: number }> {
  const anchors = new Map<string, { x: number; y: number }>();
  const active = stmts.filter(isActive);

  // Build broader tree using raw IRI values
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  const orderOf = new Map<string, number>();
  const labels = new Map<string, string>();

  for (const s of active) {
    if (s.s.kind !== 'iri') continue;
    if (s.p.value === SKOS_BROADER && s.o.kind === 'iri') {
      parentOf.set(s.s.value, s.o.value);
      if (!childrenOf.has(s.o.value)) childrenOf.set(s.o.value, []);
      childrenOf.get(s.o.value)!.push(s.s.value);
    }
    if (s.p.value === NAV_ORDER && s.o.kind === 'literal') {
      orderOf.set(s.s.value, parseInt(s.o.value, 10));
    }
    if (s.p.value === RDFS_LABEL && s.o.kind === 'literal') {
      labels.set(s.s.value, s.o.value);
    }
  }

  // Map node keys to IRIs (node key = 'i:' + iri for IRI nodes)
  const keyToIri = new Map<string, string>();
  const iriToKey = new Map<string, string>();
  for (const n of nodes) {
    if (n.key.startsWith('i:')) {
      const iri = n.key.slice(2);
      keyToIri.set(n.key, iri);
      iriToKey.set(iri, n.key);
    }
  }

  // Find roots in the broader tree
  const allBroaderIris = new Set([...parentOf.keys(), ...childrenOf.keys()]);
  const rootIris = [...allBroaderIris].filter(iri => !parentOf.has(iri) && childrenOf.has(iri));

  if (rootIris.length === 0) {
    // No hierarchy found — fall back to empty anchors (force layout takes over)
    return anchors;
  }

  // BFS to assign rings (depth levels)
  const depthOf = new Map<string, number>();
  const queue: string[] = [];

  // Roots at depth 0 (center)
  for (const r of rootIris) {
    depthOf.set(r, 0);
    queue.push(r);
  }

  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const d = depthOf.get(cur)!;
    const children = childrenOf.get(cur) ?? [];
    // Sort children by nav:order then label for deterministic placement
    children.sort((a, b) => {
      const oa = orderOf.get(a) ?? 999;
      const ob = orderOf.get(b) ?? 999;
      if (oa !== ob) return oa - ob;
      return (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b);
    });
    for (const child of children) {
      if (!depthOf.has(child)) {
        depthOf.set(child, d + 1);
        queue.push(child);
      }
    }
  }

  // Group IRIs by depth
  const maxDepth = Math.max(0, ...depthOf.values());
  const byDepth = new Map<number, string[]>();
  for (const [iri, d] of depthOf) {
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(iri);
  }

  // Sort each depth ring by: parent order → own order → label
  for (const [, iris] of byDepth) {
    iris.sort((a, b) => {
      const pa = parentOf.get(a);
      const pb = parentOf.get(b);
      // Same parent: sort by own order
      if (pa === pb) {
        const oa = orderOf.get(a) ?? 999;
        const ob = orderOf.get(b) ?? 999;
        if (oa !== ob) return oa - ob;
        return (labels.get(a) ?? a).localeCompare(labels.get(b) ?? b);
      }
      // Different parents: sort by parent's angular position
      // (determined by parent order in its ring)
      const poa = pa ? (orderOf.get(pa) ?? 999) : -1;
      const pob = pb ? (orderOf.get(pb) ?? 999) : -1;
      return poa - pob;
    });
  }

  // Place nodes in concentric rings
  const RING_SPACING = 7; // world units between rings

  for (let d = 0; d <= maxDepth; d++) {
    const iris = byDepth.get(d) ?? [];
    if (d === 0) {
      // Roots at center — spread if multiple
      if (iris.length === 1) {
        const key = iriToKey.get(iris[0]);
        if (key) anchors.set(key, { x: 0, y: 0 });
      } else {
        const r = RING_SPACING * 0.6;
        iris.forEach((iri, i) => {
          const theta = (2 * Math.PI * i) / iris.length - Math.PI / 2;
          const key = iriToKey.get(iri);
          if (key) anchors.set(key, { x: r * Math.cos(theta), y: r * Math.sin(theta) });
        });
      }
    } else {
      const r = d * RING_SPACING;
      // Place children near their parent's angular position
      const parentAngles = new Map<string, number>();
      for (const [iri] of anchors) {
        const realIri = keyToIri.get(iri);
        if (realIri) {
          const pos = anchors.get(iri)!;
          parentAngles.set(realIri, Math.atan2(pos.y, pos.x));
        }
      }

      // Group by parent for sector allocation
      const groups = new Map<string, string[]>();
      for (const iri of iris) {
        const p = parentOf.get(iri) ?? '__orphan__';
        if (!groups.has(p)) groups.set(p, []);
        groups.get(p)!.push(iri);
      }

      // Sort groups by parent angle
      const sortedGroups = [...groups.entries()].sort((a, b) => {
        const aa = parentAngles.get(a[0]) ?? 0;
        const ab = parentAngles.get(b[0]) ?? 0;
        return aa - ab;
      });

      const totalChildren = iris.length;
      let angleOffset = -Math.PI;

      for (const [parentIri, children] of sortedGroups) {
        const parentAngle = parentAngles.get(parentIri) ?? 0;
        const sector = (2 * Math.PI * children.length) / totalChildren;
        const startAngle = parentAngle - sector / 2;

        children.forEach((iri, i) => {
          const theta = children.length === 1
            ? parentAngle
            : startAngle + (i + 0.5) * (sector / children.length);
          const key = iriToKey.get(iri);
          if (key) anchors.set(key, { x: r * Math.cos(theta), y: r * Math.sin(theta) });
        });
      }
    }
  }

  // Place remaining nodes (not in broader tree) in an outer ring
  const placedKeys = new Set(anchors.keys());
  const unplaced = nodes.filter(n => !placedKeys.has(n.key));
  if (unplaced.length > 0) {
    const outerR = (maxDepth + 2) * RING_SPACING;
    unplaced.forEach((n, i) => {
      const theta = (2 * Math.PI * i) / unplaced.length;
      anchors.set(n.key, { x: outerR * Math.cos(theta), y: outerR * Math.sin(theta) });
    });
  }

  return anchors;
}
