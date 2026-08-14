/**
 * Graph traversal over node keys — the one BFS the app needs, in one place.
 *
 * Before this module there were four implementations of the same walk:
 *   - buildFocusAnchors()  (KnowledgeGraph2D.svelte) — hop distances for the focus layout,
 *     computed and then DISCARDED once anchors were placed.
 *   - focusDistances       (KnowledgeGraph.svelte) — the 3D twin of the same thing.
 *   - islandNodes          ((app)/+page.svelte) — connected components, to find islands.
 *   - splitByConcept()     (rdf/reasoning.ts) — reachability with no depth cap.
 * Four copies of one idea is how they drift: the two focus versions were already O(V*E),
 * rescanning every edge for every dequeued node, because an edge LIST is not an adjacency
 * map and nobody built one.
 *
 * Everything here works on opaque string keys (the app uses termKey() output — `i:<iri>`
 * for entities, `src:<id>` for source nodes), so this module needs no RDF types and stays
 * trivially testable.
 */

/** Undirected adjacency: node key → the keys it touches. */
export type Adjacency = Map<string, Set<string>>;

/** Build an undirected adjacency map from pairs of connected keys. */
export function adjacencyFromPairs(pairs: Iterable<readonly [string, string]>): Adjacency {
  const adj: Adjacency = new Map();
  for (const [a, b] of pairs) {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  return adj;
}

/**
 * BFS hop distances from `seed`, inclusive of the seed at distance 0.
 *
 * `maxDepth` caps the walk: `Infinity` (the default) reproduces the old uncapped behavior,
 * which the focus layouts rely on because they need the true maximum distance to exile
 * unreachable nodes beyond it.
 *
 * Returns only REACHED nodes — absence from the map means unreachable, which callers
 * distinguish from "distance 0".
 */
export function hopDistances(adj: Adjacency, seed: string, maxDepth = Infinity): Map<string, number> {
  const dist = new Map<string, number>([[seed, 0]]);
  if (maxDepth < 1) return dist;
  const queue: string[] = [seed];
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++];
    const d = dist.get(cur)!;
    if (d >= maxDepth) continue;
    for (const next of adj.get(cur) ?? EMPTY) {
      if (!dist.has(next)) {
        dist.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  return dist;
}

const EMPTY: ReadonlySet<string> = new Set();

/**
 * Every node within `depth` hops of `seed`, INCLUDING the seed.
 *
 * This is the working-set primitive for set selection (F101): "this node and everything
 * related to it" is depth 1; 2 and 3 widen it. The seed is included because a set that
 * excludes the node you selected is not the set you asked for.
 */
export function nHopNeighbours(adj: Adjacency, seed: string, depth = 1): Set<string> {
  return new Set(hopDistances(adj, seed, depth).keys());
}

/** The full connected component containing `seed` (unbounded reachability). */
export function connectedComponent(adj: Adjacency, seed: string): Set<string> {
  return new Set(hopDistances(adj, seed).keys());
}

/**
 * All connected components across `nodes`, largest-first is NOT guaranteed — order follows
 * iteration order of `nodes`, which keeps this deterministic for a given input.
 *
 * `nodes` is passed explicitly rather than derived from the adjacency because an isolated
 * node has no edges and therefore no adjacency entry, yet is still a component of size 1.
 * Deriving the node set from the edges would silently drop exactly those nodes — and
 * isolated nodes are the whole point of the islands filter that uses this.
 */
export function connectedComponents(adj: Adjacency, nodes: Iterable<string>): Set<string>[] {
  const seen = new Set<string>();
  const out: Set<string>[] = [];
  for (const n of nodes) {
    if (seen.has(n)) continue;
    const comp = connectedComponent(adj, n);
    for (const k of comp) seen.add(k);
    out.push(comp);
  }
  return out;
}
