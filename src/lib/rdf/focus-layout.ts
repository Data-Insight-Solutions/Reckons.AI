/**
 * FOCUS LAYOUT — where each node sits relative to the selected one, as polar placement.
 *
 * WHY THIS IS A MODULE AND NOT A METHOD. The same algorithm was written twice, once in
 * KnowledgeGraph.svelte and once in KnowledgeGraph2D.svelte: same hop distances, same grouping of
 * hop-1 neighbours by predicate, same in/out arc split, same angle inheritance for hop 2 and
 * beyond. rdf/map-layout.ts and rdf/timeline-layout.ts were extracted for exactly this reason —
 * the note in KnowledgeGraph2D records that the two renderers "drifted apart on undated nodes"
 * before the timeline math was shared. Five layouts were still duplicated when this was written;
 * this is the first of them.
 *
 * IT RETURNS POLAR PLACEMENT, NOT COORDINATES, because that is the honest shared part. 2D lays
 * the rings on a plane and 3D has a third dimension to spend, so forcing one coordinate type
 * would make the module lie about one of its callers. Hop and angle are what the two agree on.
 */

export type FocusEdge = { a: string; b: string; predicate: string };

export type FocusPlacement = {
  /** Hops from the selected node. 0 is the selection itself. */
  hop: number;
  /** Radians. Undefined only for the selection, which has no direction. */
  angle: number;
  /** True when the node is not reachable from the selection at all. */
  unreachable: boolean;
};

/** Gap in radians held open between the outgoing and incoming arcs so the two read as distinct. */
const GAP = 0.3;
/** Outgoing never takes less than this share of the circle, or a lopsided graph hides one side. */
const MIN_SHARE = 0.22;
const MAX_SHARE = 0.78;

/**
 * Hop distances from `selected`, over an undirected reading of the edges.
 * Kept here rather than imported so the module has no dependency beyond its own types; the
 * renderers' shared n-hop helper computes the same thing and the test pins them as equal.
 */
function hopsFrom(edges: FocusEdge[], selected: string): Map<string, number> {
  const adj = new Map<string, string[]>();
  const link = (x: string, y: string) => {
    if (!adj.has(x)) adj.set(x, []);
    adj.get(x)!.push(y);
  };
  for (const e of edges) { link(e.a, e.b); link(e.b, e.a); }

  const dist = new Map<string, number>([[selected, 0]]);
  let frontier = [selected];
  while (frontier.length) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const n of adj.get(k) ?? []) {
        if (dist.has(n)) continue;
        dist.set(n, dist.get(k)! + 1);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

/**
 * Place every key relative to `selected`.
 *
 * Hop 1 is grouped BY PREDICATE and split into an outgoing arc and an incoming one, so direction
 * is readable from position rather than only from an arrowhead. Hop 2+ inherits its parent's
 * angle and fans around it, which is what keeps a branch together instead of scattering its
 * children around the whole ring. Unreachable nodes are placed beyond the last hop rather than
 * dropped — the same rule the map layout applies to nodes with no coordinates, for the same
 * reason: silently omitting them makes a graph look smaller than it is.
 */
export function focusPlacement(
  edges: FocusEdge[],
  allKeys: string[],
  selected: string | null,
): { placement: Map<string, FocusPlacement>; maxHop: number } {
  const placement = new Map<string, FocusPlacement>();
  if (!selected) return { placement, maxHop: 0 };

  const dist = hopsFrom(edges, selected);
  const maxHop = dist.size > 0 ? Math.max(...dist.values()) : 0;
  placement.set(selected, { hop: 0, angle: 0, unreachable: false });

  // ── hop 1: grouped by predicate, split by direction ────────────────────────
  const outGroups = new Map<string, string[]>();
  const inGroups = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, p: string, k: string) => {
    if (!m.has(p)) m.set(p, []);
    if (!m.get(p)!.includes(k)) m.get(p)!.push(k);
  };
  for (const e of edges) {
    if (e.a === selected && dist.get(e.b) === 1) push(outGroups, e.predicate, e.b);
    if (e.b === selected && dist.get(e.a) === 1) push(inGroups, e.predicate, e.a);
  }

  const outCount = [...outGroups.values()].reduce((s, a) => s + a.length, 0);
  const inCount = [...inGroups.values()].reduce((s, a) => s + a.length, 0);
  const total = outCount + inCount;

  if (total > 0) {
    let outArc: number, inArc: number, outStart: number, inStart: number;
    if (inCount === 0) { outArc = 2 * Math.PI; outStart = -Math.PI; inArc = 0; inStart = 0; }
    else if (outCount === 0) { inArc = 2 * Math.PI; inStart = -Math.PI; outArc = 0; outStart = 0; }
    else {
      const fOut = Math.max(MIN_SHARE, Math.min(MAX_SHARE, outCount / total));
      outArc = fOut * (2 * Math.PI) - GAP;
      inArc = (1 - fOut) * (2 * Math.PI) - GAP;
      outStart = Math.PI / 2 - outArc / 2;
      inStart = -Math.PI / 2 - inArc / 2;
    }
    const placeArc = (groups: Map<string, string[]>, tot: number, start: number, arc: number) => {
      let angle = start;
      for (const [, keys] of groups) {
        if (!keys.length) continue;
        const sector = arc * (keys.length / tot);
        const mid = angle + sector / 2;
        keys.forEach((k, i) => {
          const a = keys.length === 1 ? mid : angle + (i + 0.5) * (sector / keys.length);
          placement.set(k, { hop: 1, angle: a, unreachable: false });
        });
        angle += sector;
      }
    };
    placeArc(outGroups, outCount, outStart, outArc);
    placeArc(inGroups, inCount, inStart, inArc);
  }

  // ── hop 2+: fan around the parent's angle so a branch stays together ───────
  for (let hop = 2; hop <= maxHop; hop++) {
    const atHop = [...dist.entries()].filter(([, d]) => d === hop).map(([k]) => k);
    const byParent = new Map<string, string[]>();
    for (const k of atHop) {
      let parent: string | null = null;
      for (const e of edges) {
        if (e.a === k && dist.get(e.b) === hop - 1) { parent = e.b; break; }
        if (e.b === k && dist.get(e.a) === hop - 1) { parent = e.a; break; }
      }
      const g = parent ?? '__none__';
      if (!byParent.has(g)) byParent.set(g, []);
      byParent.get(g)!.push(k);
    }
    for (const [parent, siblings] of byParent) {
      const base = parent === '__none__' ? 0 : (placement.get(parent)?.angle ?? 0);
      const fan = Math.min(Math.PI * 0.35, (Math.PI * 0.7) / Math.max(siblings.length, 1));
      siblings.forEach((k, i) => {
        const a = base + (siblings.length === 1 ? 0 : (i - (siblings.length - 1) / 2) * fan);
        placement.set(k, { hop, angle: a, unreachable: false });
      });
    }
  }

  // ── unreachable: a ring beyond the last hop, evenly spaced ─────────────────
  const unreachable = allKeys.filter((k) => !placement.has(k));
  unreachable.forEach((k, i) => {
    placement.set(k, {
      hop: maxHop + 2.5,
      angle: (2 * Math.PI * i) / Math.max(unreachable.length, 1),
      unreachable: true,
    });
  });

  return { placement, maxHop };
}

/** Convert a placement to plane coordinates. `ringRadius` is the distance between hops. */
export function toPlane(p: FocusPlacement, ringRadius: number): { x: number; y: number } {
  const r = p.hop * ringRadius;
  return { x: r * Math.cos(p.angle), y: r * Math.sin(p.angle) };
}
