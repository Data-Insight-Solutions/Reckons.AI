/**
 * grid-balance (F274.4.x, SCRIPT tier): pure row arithmetic for a CSS grid of cards.
 *
 * Given the column tracks of a grid container and the rendered boxes of its children, work out for
 * every grid row which columns are occupied (a tall card keeps its columns occupied in the rows it
 * spans) and report the columns left empty, in runs. An empty run that starts at column 0 is
 * "empty space on the left"; one that reaches the last column is a ragged right edge. No browser here:
 * site-layout-check.ts measures the boxes, this file does the sums so they can be unit-tested.
 */
export interface Track { x0: number; x1: number }
export interface Box { left: number; top: number; right: number; bottom: number }
export interface RowReport { top: number; occupied: number[]; empty: number[]; runs: { from: number; to: number }[]; startGap: boolean; endGap: boolean }

const TOL = 2;

export function colsOf(tracks: Track[], b: Box): number[] {
  const out: number[] = [];
  tracks.forEach((t, i) => { if (Math.min(b.right, t.x1) - Math.max(b.left, t.x0) > TOL) out.push(i); });
  return out;
}

export function rowBalance(tracks: Track[], boxes: Box[]): RowReport[] {
  const tops: number[] = [];
  for (const b of [...boxes].sort((a, c) => a.top - c.top)) if (!tops.some((t) => Math.abs(t - b.top) <= TOL)) tops.push(b.top);
  return tops.map((top) => {
    const occ = new Set<number>();
    for (const b of boxes) if (b.top <= top + TOL && b.bottom > top + TOL) colsOf(tracks, b).forEach((c) => occ.add(c));
    const occupied = [...occ].sort((a, c) => a - c);
    const empty = tracks.map((_, i) => i).filter((i) => !occ.has(i));
    const runs: { from: number; to: number }[] = [];
    for (const c of empty) { const r = runs[runs.length - 1]; if (r && r.to === c - 1) r.to = c; else runs.push({ from: c, to: c }); }
    return { top, occupied, empty, runs, startGap: empty.includes(0), endGap: empty.includes(tracks.length - 1) };
  });
}

/** Rows with at least one empty column. */
export const unbalancedRows = (rows: RowReport[]): RowReport[] => rows.filter((r) => r.empty.length > 0);
