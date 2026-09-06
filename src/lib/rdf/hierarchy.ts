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

/**
 * `kpred:depends-on` is a hierarchy edge too, and it points the OTHER WAY.
 *
 * `A skos:broader B` reads "A is under B", so B is the parent. `A depends-on B` reads "A needs B" —
 * B is the PREREQUISITE, so B is again the parent, but the statement is written from the child. Read
 * naively as broader-shaped it inverts the tree and puts the dependents above the thing they wait on.
 *
 * This matters because the roadmap states 140 depends-on edges while the pending queue carries
 * almost no `blocks` — so dependency structure the graph genuinely knows about was invisible to the
 * only layout able to draw a tree.
 */
export const KPRED_DEPENDS_ON = 'urn:kbase:predicate/depends-on';

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
 * Resolve hierarchy edges into a deterministic forest.
 *
 * Real imported graphs are not always trees: a child can name multiple parents,
 * and malformed data can contain self-loops or longer cycles. Layout and
 * navigation must still terminate and include every participant exactly once.
 * An explicit taxonomy outranks a dependency; equal-ranked parents are chosen
 * lexicographically so statement order cannot change the result. Cycles are
 * broken at their lexicographically smallest IRI, making that node a root.
 */
export function buildHierarchyParentMaps(
  stmts: Statement[],
  includeDependencies = false,
): {
  parentOf: Map<string, string>;
  childrenOf: Map<string, string[]>;
  allIris: Set<string>;
} {
  const candidates = new Map<string, Map<string, number>>();
  const allIris = new Set<string>();

  for (const s of stmts) {
    if (!isActive(s) || s.s.kind !== 'iri' || s.o.kind !== 'iri') continue;
    const priority = s.p.value === SKOS_BROADER
      ? 2
      : includeDependencies && s.p.value === KPRED_DEPENDS_ON
        ? 1
        : 0;
    if (!priority) continue;

    allIris.add(s.s.value);
    allIris.add(s.o.value);
    const parents = candidates.get(s.s.value) ?? new Map<string, number>();
    parents.set(s.o.value, Math.max(priority, parents.get(s.o.value) ?? 0));
    candidates.set(s.s.value, parents);
  }

  const parentOf = new Map<string, string>();
  for (const child of [...candidates.keys()].sort()) {
    const choices = [...candidates.get(child)!]
      .sort(([parentA, priorityA], [parentB, priorityB]) =>
        priorityB - priorityA || parentA.localeCompare(parentB));
    if (choices[0]) parentOf.set(child, choices[0][0]);
  }

  // parentOf is a functional graph (at most one outgoing parent per child),
  // so deleting one edge per detected cycle turns it into a forest.
  const settled = new Set<string>();
  for (const start of [...allIris].sort()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const pathIndex = new Map<string, number>();
    let current = start;
    while (parentOf.has(current) && !settled.has(current)) {
      const cycleStart = pathIndex.get(current);
      if (cycleStart !== undefined) {
        const cycle = path.slice(cycleStart);
        const promotedRoot = [...cycle].sort()[0];
        parentOf.delete(promotedRoot);
        break;
      }
      pathIndex.set(current, path.length);
      path.push(current);
      current = parentOf.get(current)!;
    }
    for (const iri of path) settled.add(iri);
  }

  const childrenOf = new Map<string, string[]>();
  for (const [child, parent] of [...parentOf].sort(([a], [b]) => a.localeCompare(b))) {
    const children = childrenOf.get(parent) ?? [];
    children.push(child);
    childrenOf.set(parent, children);
  }
  return { parentOf, childrenOf, allIris };
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

  // Build a deterministic, cycle-safe parent → children forest.
  const { parentOf, childrenOf, allIris } = buildHierarchyParentMaps(active);

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

  // Every promoted cycle root participates even if the malformed component was
  // only a self-loop and therefore has no remaining child edge.
  const rootIris = [...allIris].filter(iri => !parentOf.has(iri)).sort();

  // Pre-compute each node's depth and the total depth of its tree iteratively.
  // Imported taxonomies can be thousands of levels deep; recursive descent would
  // overflow the JavaScript call stack even though the data is a valid forest.
  const depthOf = new Map<string, number>();
  const rootMaxDepth = new Map<string, number>();
  for (const root of rootIris) {
    let maxDepth = 0;
    const stack: Array<{ iri: string; depth: number }> = [{ iri: root, depth: 0 }];
    while (stack.length > 0) {
      const { iri, depth } = stack.pop()!;
      depthOf.set(iri, depth);
      maxDepth = Math.max(maxDepth, depth);
      const children = childrenOf.get(iri) ?? [];
      for (let i = children.length - 1; i >= 0; i--) {
        stack.push({ iri: children[i], depth: depth + 1 });
      }
    }
    rootMaxDepth.set(root, maxDepth);
  }

  // Build children before parents using an explicit post-order stack. This keeps
  // the public nested shape without coupling supported data depth to call-stack size.
  const built = new Map<string, HierarchyNode>();
  for (const root of rootIris) {
    const stack: Array<{ iri: string; expanded: boolean }> = [{ iri: root, expanded: false }];
    while (stack.length > 0) {
      const { iri, expanded } = stack.pop()!;
      if (!expanded) {
        stack.push({ iri, expanded: true });
        const children = childrenOf.get(iri) ?? [];
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ iri: children[i], expanded: false });
        }
        continue;
      }

      const children = (childrenOf.get(iri) ?? [])
        .map((child) => built.get(child)!)
        .sort((a, b) => a.order - b.order);
      built.set(iri, {
        iri,
        label: labels.get(iri) ?? iri.split('/').pop() ?? iri,
        layer: layerOf.get(iri) ?? ((rootMaxDepth.get(root) ?? 0) - (depthOf.get(iri) ?? 0)),
        order: orderOf.get(iri) ?? 0,
        children,
        parent: parentOf.get(iri) ?? null,
        next: nextOf.get(iri) ?? null,
        prev: prevOf.get(iri) ?? null,
      });
    }
  }

  const roots = rootIris
    .map(iri => built.get(iri)!)
    .sort((a, b) => a.order - b.order || a.label.localeCompare(b.label) || a.iri.localeCompare(b.iri));

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
  const { parentOf, childrenOf, allIris } = buildHierarchyParentMaps(active, true);
  const orderOf = new Map<string, number>();
  const labels = new Map<string, string>();

  for (const s of active) {
    if (s.s.kind !== 'iri') continue;
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
  const rootIris = [...allIris].filter(iri => !parentOf.has(iri)).sort();

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

  // LAYERED TREE: each depth is its own circle, dropped below the one above it.
  //
  // This was concentric rings in a single plane — depth read as distance from a centre. That draws
  // a target, not a tree: with several roots the middle is a crowd, and "below" (which is how a
  // dependency actually reads — prerequisite above, dependent under it) had no direction at all.
  // Now depth owns the vertical axis and each level spreads around its own circle, so the shape
  // says what the data says: one level of prerequisites, and everything that hangs beneath it.
  const RING_SPACING = 7;  // retained: sets each level's circle size
  const LEVEL_DROP  = 9;   // vertical gap between one level's circle and the next

  /*
   * DEPTH GROWS DOWNWARD, AND THE TREE IS CENTRED ON THE ORIGIN.
   *
   * Two bugs, both reported by looking at it (Matt, 2026-08-21): "the 'root' was down a level and
   * not at highest level", and "the graph appears below the central focus of the screen and I
   * needed to manually drag each load."
   *
   * 1. INVERTED. This is the 2D layout and KnowledgeGraph2D's worldToScreen does NOT flip y —
   *    screen y grows downward, canvas-style. Levels were placed at `-d * LEVEL_DROP`, which is
   *    correct for the 3D twin (y-up) and upside down here: the root sat at the BOTTOM with its
   *    descendants climbing above it, and the unplaced ring — meant to hang below the tree —
   *    floated over the top of everything.
   *
   * 2. OFF-CENTRE. Levels ran from 0 to ±(maxDepth * LEVEL_DROP), so the tree's centroid was half
   *    its own height away from the origin the camera frames. Every load needed a manual drag.
   *    Centring costs one subtraction and removes the drag entirely.
   */
  const span = maxDepth * LEVEL_DROP;
  const yOfDepth = (d: number) => (d * LEVEL_DROP - span / 2) || 0;

  /** Radius of the circle a level's nodes sit on — wide enough that they do not collide. */
  const levelRadius = (count: number) => (count <= 1 ? 0 : Math.max(RING_SPACING * 0.55, count * 1.15));

  for (let d = 0; d <= maxDepth; d++) {
    const iris = byDepth.get(d) ?? [];
    // `|| 0` normalizes the negative zero that -0 * LEVEL_DROP produces at depth 0. Harmless to
    // render, but it makes coordinates compare unequal under Object.is and reads as a sign.
    const levelY = yOfDepth(d);

    if (d === 0) {
      // Roots share the top circle. A single root sits at its centre.
      const r = levelRadius(iris.length);
      iris.forEach((iri, i) => {
        const theta = (2 * Math.PI * i) / iris.length - Math.PI / 2;
        const key = iriToKey.get(iri);
        if (key) anchors.set(key, { x: (r * Math.cos(theta)) || 0, y: (levelY + r * Math.sin(theta)) || 0 });
      });
    } else {
      const r = levelRadius(iris.length);
      // Keep a child near its parent's angle on the level above, so edges stay short and the
      // descent is legible. The angle is measured about the PARENT LEVEL'S OWN CENTRE, not the
      // world origin — once levels are stacked, atan2 on raw coordinates is dominated by the
      // vertical drop and every parent collapses to roughly the same angle.
      const parentLevelY = yOfDepth(d - 1);
      const parentAngles = new Map<string, number>();
      for (const [key] of anchors) {
        const realIri = keyToIri.get(key);
        if (realIri) {
          const pos = anchors.get(key)!;
          parentAngles.set(realIri, Math.atan2(pos.y - parentLevelY, pos.x));
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

      /*
       * SEQUENTIAL SECTORS WITH A GAP BETWEEN SUB-TREES.
       *
       * The previous version centred each group's sector on its PARENT'S angle and sized sectors to
       * fill the circle exactly. Two parents at similar angles therefore received overlapping
       * sectors, and with no padding between groups even non-overlapping ones ran edge to edge —
       * so the sub-trees read as one undifferentiated ring and you could not see where one branch
       * ended and the next began. (`let angleOffset = -Math.PI` sat here unused: sequential
       * allocation was intended once and never finished.)
       *
       * Groups are already sorted by parent angle, so walking them in order around the circle keeps
       * each branch on the side its parent is on — the property centring was for — while
       * GUARANTEEING separation, which centring could not. Each group gets a slice proportional to
       * its size out of the circle MINUS the gaps, and the gaps are what make the branches legible.
       */
      const GROUP_GAP = sortedGroups.length > 1
        // Never let padding eat more than a third of the circle: with many small branches the gaps
        // would otherwise dominate and squeeze every branch into a thin spike.
        ? Math.min(0.22, (2 * Math.PI) / 3 / sortedGroups.length)
        : 0;
      const usable = 2 * Math.PI - GROUP_GAP * sortedGroups.length;

      // Start so the first group's centre lands where the old code would have put it, keeping the
      // figure's overall orientation stable rather than rotating the whole level.
      let cursor = -Math.PI + GROUP_GAP / 2;

      for (const [, children] of sortedGroups) {
        const sector = (usable * children.length) / totalChildren;
        children.forEach((iri, i) => {
          // Children sit at slice centres INSIDE their group's sector, so a lone child is centred
          // in its own sector rather than pinned to its parent's exact angle — which is what let
          // two single-child branches land on top of each other.
          const theta = cursor + (i + 0.5) * (sector / children.length);
          const key = iriToKey.get(iri);
          if (key) anchors.set(key, { x: (r * Math.cos(theta)) || 0, y: (levelY + r * Math.sin(theta)) || 0 });
        });
        cursor += sector + GROUP_GAP;
      }
    }
  }

  // Nodes the hierarchy says nothing about get their own circle one level BELOW the tree, rather
  // than an outer ring that would read as the deepest descendants of it. They are unplaced, not
  // subordinate — the graph states no parent for them.
  const placedKeys = new Set(anchors.keys());
  const unplaced = nodes.filter(n => !placedKeys.has(n.key));
  if (unplaced.length > 0) {
    // CONCENTRIC rings of bounded radius, not one ring sized by population.
    //
    // A single circle whose radius grew with node count put 640 unplaced nodes on a ring of radius
    // ~736 while a real level ring is 7-20 across. The tree collapsed to a dot at the centre of an
    // enormous empty circle, and the force simulation had to settle bodies spread over a hundred
    // times the useful area — which reads as "frozen and barely moving" rather than as a layout
    // that simply looks wrong. Rings grow by a fixed step and wrap, so area scales with the square
    // root of the count and the whole figure stays the same order of size as the tree it sits under.
    // BELOW the tree, which now means a LARGER y — they are unplaced, not superior to the root.
    const orphanY = yOfDepth(maxDepth + 1.6);
    const PER_RING = 24;
    unplaced.forEach((n, i) => {
      const ring = Math.floor(i / PER_RING);
      const idx = i % PER_RING;
      const inRing = Math.min(PER_RING, unplaced.length - ring * PER_RING);
      const r = RING_SPACING * (1 + ring * 0.6);
      const theta = (2 * Math.PI * idx) / inRing;
      anchors.set(n.key, {
        x: (r * Math.cos(theta)) || 0,
        y: (orphanY + r * Math.sin(theta)) || 0,
      });
    });
  }

  return anchors;
}
