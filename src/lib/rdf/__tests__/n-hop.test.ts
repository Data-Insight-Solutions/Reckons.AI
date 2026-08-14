import { describe, it, expect } from 'vitest';
import { adjacencyFromPairs, hopDistances, nHopNeighbours, connectedComponent, connectedComponents } from '../n-hop';

/**
 * A ── B ── C ── D        (a chain)
 * A ── E                  (a second branch off A)
 * X ── Y                  (a separate component)
 * Z                       (isolated — no edges at all)
 */
const pairs: [string, string][] = [
  ['A', 'B'], ['B', 'C'], ['C', 'D'], ['A', 'E'], ['X', 'Y'],
];
const adj = adjacencyFromPairs(pairs);

describe('adjacencyFromPairs', () => {
  it('is undirected — both endpoints know each other', () => {
    expect(adj.get('A')!.has('B')).toBe(true);
    expect(adj.get('B')!.has('A')).toBe(true);
  });

  it('omits nodes that have no edges', () => {
    expect(adj.has('Z')).toBe(false);
  });
});

describe('hopDistances', () => {
  it('places the seed at 0 and counts hops outward', () => {
    const d = hopDistances(adj, 'A');
    expect(d.get('A')).toBe(0);
    expect(d.get('B')).toBe(1);
    expect(d.get('E')).toBe(1);
    expect(d.get('C')).toBe(2);
    expect(d.get('D')).toBe(3);
  });

  it('omits unreachable nodes rather than returning Infinity', () => {
    const d = hopDistances(adj, 'A');
    expect(d.has('X')).toBe(false);
    expect(d.has('Y')).toBe(false);
  });

  it('respects maxDepth', () => {
    const d = hopDistances(adj, 'A', 1);
    expect([...d.keys()].sort()).toEqual(['A', 'B', 'E']);
  });

  it('returns only the seed when maxDepth is 0', () => {
    expect([...hopDistances(adj, 'A', 0).keys()]).toEqual(['A']);
  });

  it('handles a seed with no edges', () => {
    expect([...hopDistances(adj, 'Z').keys()]).toEqual(['Z']);
  });

  it('takes the SHORTEST path when two routes exist', () => {
    // A─B─C plus a direct A─C shortcut: C must be 1, not 2.
    const shortcut = adjacencyFromPairs([['A', 'B'], ['B', 'C'], ['A', 'C']]);
    expect(hopDistances(shortcut, 'A').get('C')).toBe(1);
  });

  it('terminates on a cycle', () => {
    const cyclic = adjacencyFromPairs([['A', 'B'], ['B', 'C'], ['C', 'A']]);
    const d = hopDistances(cyclic, 'A');
    expect(d.get('A')).toBe(0);
    expect(d.size).toBe(3);
  });
});

describe('nHopNeighbours', () => {
  it('includes the seed — a set that drops the node you selected is not that set', () => {
    expect(nHopNeighbours(adj, 'A', 1).has('A')).toBe(true);
  });

  it('defaults to 1 hop', () => {
    expect([...nHopNeighbours(adj, 'A')].sort()).toEqual(['A', 'B', 'E']);
  });

  it('widens with depth', () => {
    expect([...nHopNeighbours(adj, 'A', 2)].sort()).toEqual(['A', 'B', 'C', 'E']);
    expect([...nHopNeighbours(adj, 'A', 3)].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('stops growing once the component is exhausted', () => {
    expect(nHopNeighbours(adj, 'A', 99).size).toBe(5);
  });
});

describe('connectedComponent', () => {
  it('returns the whole reachable component regardless of distance', () => {
    expect([...connectedComponent(adj, 'D')].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('does not leak into a disconnected component', () => {
    expect([...connectedComponent(adj, 'X')].sort()).toEqual(['X', 'Y']);
  });
});

describe('connectedComponents', () => {
  const allNodes = ['A', 'B', 'C', 'D', 'E', 'X', 'Y', 'Z'];

  it('partitions the node set — every node in exactly one component', () => {
    const comps = connectedComponents(adj, allNodes);
    const total = comps.reduce((n, c) => n + c.size, 0);
    expect(total).toBe(allNodes.length);
    expect(new Set(comps.flatMap((c) => [...c])).size).toBe(allNodes.length);
  });

  it('finds the three components', () => {
    const sizes = connectedComponents(adj, allNodes).map((c) => c.size).sort((a, b) => a - b);
    expect(sizes).toEqual([1, 2, 5]);
  });

  it('keeps an ISOLATED node as its own component', () => {
    // The reason `nodes` is a parameter: Z has no edges, so it has no adjacency entry and
    // would vanish if components were derived from the edge set. The islands filter exists
    // precisely to surface nodes like Z.
    const comps = connectedComponents(adj, allNodes);
    expect(comps.some((c) => c.size === 1 && c.has('Z'))).toBe(true);
  });
});
