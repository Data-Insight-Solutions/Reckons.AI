/**
 * F58.9.19.1 — the capture link table and the gap rule (pure functions only).
 *
 * Entity: kb:fusion-pooled-layout in static/reckons-roadmap.ttl.
 *
 * The MAP stage records the verified matches between every pair of captures —
 * "the link table". PASSING needs ONE model that holds every capture, i.e. one
 * group of captures joined by verified links at or above the bar. When captures
 * split into more than one group, the stage does not force them together: it
 * stops and emits a gap in the F284.2 form — "these captures do not overlap
 * enough to join; a pass that sees both areas is needed" — blocking the fused
 * target.
 *
 * No COLMAP, no pipeline wiring: the functions take capture ids and verified
 * counts, and return groups and gaps, so the rule is unit-testable on synthetic
 * data.
 */

/** One counted match row between two capture ids; the order of a, b within a pair is irrelevant. */
export interface PairMatch {
  a: string;
  b: string;
  /** Verified matches this row contributes. */
  verified: number;
}

/**
 * Symmetric lookup: `table.get(a)!.get(b)!` is the verified-link count between
 * captures a and b; 0 where nothing was given. Only pairs of DISTINCT captures
 * are stored (there is no self-link), and both directions always agree.
 */
export type LinkTable = ReadonlyMap<string, ReadonlyMap<string, number>>;

/**
 * Build the symmetric link table over the given captures. Every distinct pair
 * starts at 0; each pairMatch row adds its verified count to its pair (in either
 * order; duplicate rows for the same pair sum). Rows naming a capture that is
 * not in the list, or a capture paired with itself, are ignored.
 */
export function linkTable(
  captures: readonly string[],
  pairMatches: readonly PairMatch[],
): LinkTable {
  const table = new Map<string, Map<string, number>>();
  for (const id of captures) table.set(id, new Map());
  for (const a of captures) {
    const rowA = table.get(a)!;
    for (const b of captures) {
      if (a !== b) rowA.set(b, 0);
    }
  }
  for (const { a, b, verified } of pairMatches) {
    const rowA = table.get(a);
    const rowB = table.get(b);
    if (!rowA || !rowB || a === b) continue;
    rowA.set(b, (rowA.get(b) ?? 0) + verified);
    rowB.set(a, (rowB.get(a) ?? 0) + verified);
  }
  return table;
}

/**
 * Group captures joined by pairs with at least minLinks verified links — the
 * connected components of the table's above-bar edges. Captures inside a group
 * keep table order; groups appear in order of first appearance. One capture, or
 * a table with no above-bar pair, gives one group per capture.
 */
export function components(table: LinkTable, minLinks: number): string[][] {
  const parent = new Map<string, string>();
  for (const id of table.keys()) parent.set(id, id);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (cur !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const [a, row] of table) {
    for (const [b, count] of row) {
      if (a !== b && count >= minLinks) union(a, b);
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const id of table.keys()) {
    const root = find(id);
    const group = byRoot.get(root);
    if (group) group.push(id);
    else byRoot.set(root, [id]);
  }
  return [...byRoot.values()];
}

/** The gap the MAP stage emits (F284.2 form): it names the two groups and blocks the fused target. */
export interface Gap {
  /** The two groups of captures that do not overlap enough to join. */
  between: [string[], string[]];
  /** The fused target this gap blocks. */
  blocks: string;
  /** The gap's text, in the F284.2 form. */
  text: string;
}

const GAP_TEXT = 'These captures do not overlap enough to join; a pass that sees both areas is needed';

/**
 * The gap rule: no gap when the captures form one group (or none at all);
 * otherwise one gap per PAIR of groups, each blocking the fused target. Group
 * order follows the input; each gap names the earlier group first.
 */
export function gapsFor(groups: readonly (readonly string[])[], targetId: string): Gap[] {
  if (groups.length <= 1) return [];
  const gaps: Gap[] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      gaps.push({
        between: [groups[i] as string[], groups[j] as string[]],
        blocks: targetId,
        text: GAP_TEXT,
      });
    }
  }
  return gaps;
}
