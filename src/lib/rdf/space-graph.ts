/**
 * THE SPACES MAP — the graph of graphs (F218 phase 1). Pure: no storage, no DOM.
 *
 * Matt, 2026-09-23: "I would like to visualize the interconnected graphs, like we visualize nodes
 * within a graph." A space is a node, leaps between spaces are edges, and a set of spaces is a
 * cluster. Everything here is derived from data that already exists: the registry (spaces), the
 * leap triples inside each space (edges, see kb-leap.ts) and the set buckets the Spaces tab already
 * computes (graph-sets.ts). No new vocabulary; a leap edge is what VoID calls a Linkset.
 *
 * Three decisions from the F218 entity, each visible below:
 *   - MANY LEAPS THICKEN ONE EDGE. Leaps between a pair aggregate into a single edge, and because a
 *     leap is one-way in the data, the edge keeps a count per direction instead of collapsing.
 *   - SET MEMBERSHIP IS SPATIAL. Spaces in one set cluster around the set's own centre.
 *   - DELIBERATELY SIMPLER THAN THE EXPLORER. A deterministic polar placement, not a force
 *     simulation: tens of spaces, a layout that does not move when facts change, and a picture that
 *     is the same every time it is opened.
 */
import type { Statement } from './types';
import { LEAP_PRED, classifyLeap } from './kb-leap';

/** Outgoing leaps from one space, by target stable id. Only active, space-to-space leaps count. */
export function leapTargetCounts(stmts: readonly Statement[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of stmts) {
    if (s.p.value !== LEAP_PRED || s.status === 'rejected' || s.status === 'superseded') continue;
    const target = s.o.value;
    if (classifyLeap(target) !== 'kb') continue;
    out[target] = (out[target] ?? 0) + 1;
  }
  return out;
}

export type SpaceInput = {
  id: string;
  name: string;
  stableId?: string;
  statementCount?: number;
  /** Outgoing leaps by target stable id. Undefined means NOT COUNTED YET, which is not zero. */
  leapTargets?: Record<string, number>;
};

export type SetInput = { id: string; title: string; basis: string; memberIds: string[] };

export type SpaceNode = {
  id: string;
  name: string;
  setId: string;
  statementCount: number;
  leapsCounted: boolean;
  /** Leaps from this space to a stable id no registered space carries. */
  unresolvedLeaps: number;
  x: number; y: number; r: number;
  /** Label position, pushed radially OUTWARD from the set's centre so labels in a cluster do not collide. */
  lx: number; ly: number; anchor: 'start' | 'middle' | 'end';
};

export type SpaceEdge = {
  /** Endpoints in a stable order (a < b), so one pair is always one edge. */
  a: string; b: string;
  aToB: number; bToA: number;
  total: number;
};

export type SetRegion = { id: string; title: string; basis: string; x: number; y: number; r: number; count: number };

export type SpaceGraph = {
  nodes: SpaceNode[];
  edges: SpaceEdge[];
  regions: SetRegion[];
  /** Spaces whose leaps have not been counted — the map cannot claim they have none. */
  uncounted: number;
  width: number; height: number;
};

/** Aggregate leaps into one edge per unordered pair, with a count per direction. */
export function aggregateEdges(spaces: readonly SpaceInput[]): { edges: SpaceEdge[]; unresolved: Map<string, number> } {
  const byStable = new Map<string, string>();
  for (const s of spaces) if (s.stableId) byStable.set(s.stableId, s.id);
  const pairs = new Map<string, SpaceEdge>();
  const unresolved = new Map<string, number>();
  for (const from of spaces) {
    for (const [target, n] of Object.entries(from.leapTargets ?? {})) {
      const to = byStable.get(target);
      if (!to) { unresolved.set(from.id, (unresolved.get(from.id) ?? 0) + n); continue; }
      if (to === from.id) continue; // a space leaping to itself says nothing about the relation between spaces
      const [a, b] = from.id < to ? [from.id, to] : [to, from.id];
      const key = `${a}\u0000${b}`;
      const e = pairs.get(key) ?? { a, b, aToB: 0, bToA: 0, total: 0 };
      if (from.id === a) e.aToB += n; else e.bToA += n;
      e.total += n;
      pairs.set(key, e);
    }
  }
  return { edges: [...pairs.values()].sort((x, y) => y.total - x.total || x.a.localeCompare(y.a)), unresolved };
}

const NODE_MIN = 10, NODE_MAX = 26;

/** Node radius from statement count: square-root scaled so area, not radius, tracks size. */
export function nodeRadius(count: number, maxCount: number): number {
  if (maxCount <= 0 || count <= 0) return NODE_MIN;
  return NODE_MIN + (NODE_MAX - NODE_MIN) * Math.sqrt(count / maxCount);
}

/**
 * Deterministic placement. Sets sit on a ring around the centre, ordered as given (the Spaces tab's
 * own set order); each set's spaces sit on a small ring around that set's centre. A single set is
 * placed at the centre. The same input always yields the same picture.
 */
export function buildSpaceGraph(spaces: readonly SpaceInput[], sets: readonly SetInput[], size = 560): SpaceGraph {
  const width = size, height = size, cx = width / 2, cy = height / 2;
  const { edges, unresolved } = aggregateEdges(spaces);
  const maxCount = Math.max(0, ...spaces.map((s) => s.statementCount ?? 0));
  const setOf = new Map<string, string>();
  for (const set of sets) for (const m of set.memberIds) if (!setOf.has(m)) setOf.set(m, set.id);

  const liveSets = sets.filter((s) => s.memberIds.some((m) => spaces.some((sp) => sp.id === m)));
  const innerOf = (n: number) => (n > 1 ? Math.max(50, 28 + n * 12) : 0);
  const regionR = (n: number) => innerOf(n) + NODE_MAX + 32;
  // Place set centres so the LARGEST region, and the title drawn above it, stays inside the frame.
  const biggest = Math.max(0, ...liveSets.map((set) => regionR(spaces.filter((sp) => setOf.get(sp.id) === set.id).length)));
  const outer = liveSets.length > 1 ? Math.max(0, Math.min(width, height) / 2 - biggest - 24) : 0;
  const regions: SetRegion[] = [];
  const nodes: SpaceNode[] = [];

  liveSets.forEach((set, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, liveSets.length);
    const sx = cx + outer * Math.cos(angle), sy = cy + outer * Math.sin(angle);
    const members = spaces.filter((sp) => setOf.get(sp.id) === set.id);
    const inner = innerOf(members.length);
    members.forEach((sp, j) => {
      const a = -Math.PI / 2 + (2 * Math.PI * j) / Math.max(1, members.length);
      const r = nodeRadius(sp.statementCount ?? 0, maxCount);
      const x = sx + inner * Math.cos(a), y = sy + inner * Math.sin(a);
      // A lone space labels below; a clustered one labels away from the cluster's centre.
      const [dx, dy] = members.length > 1 ? [Math.cos(a), Math.sin(a)] : [0, 1];
      const anchor = dx > 0.35 ? 'start' : dx < -0.35 ? 'end' : 'middle';
      const lx = x + dx * (r + 8);
      const ly = y + dy * (r + 8) + (anchor === 'middle' ? (dy >= 0 ? 16 : -4) : 6);
      nodes.push({
        id: sp.id, name: sp.name, setId: set.id,
        statementCount: sp.statementCount ?? 0,
        leapsCounted: sp.leapTargets !== undefined,
        unresolvedLeaps: unresolved.get(sp.id) ?? 0,
        x, y, r, lx, ly, anchor,
      });
    });
    regions.push({ id: set.id, title: set.title, basis: set.basis, x: sx, y: sy, r: regionR(members.length), count: members.length });
  });

  return { nodes, edges, regions, uncounted: spaces.filter((s) => s.leapTargets === undefined).length, width, height };
}

/** Edge stroke width: grows with the square root of the leap count, capped so one edge cannot swamp the map. */
export function edgeWidth(total: number): number {
  return Math.min(9, 1.5 + Math.sqrt(total) * 1.5);
}
