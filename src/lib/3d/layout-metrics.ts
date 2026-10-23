/**
 * How spread out a settled layout is (F58.9.16 / F220): the two numbers used to judge "a bit more
 * spread out" instead of the eye. Pure, so a change to the force or ring parameters can be measured
 * rather than argued.
 *
 *  - meanNearest: the mean, over nodes, of the centre-to-centre distance to the closest other node.
 *  - overlaps: pairs of nodes whose drawn circles (their radii) intersect.
 *
 * KnowledgeGraph writes them to the canvas (data-spread) once the layout has settled, so a browser
 * test can read what the user is looking at.
 */
export interface SpreadPoint { x: number; y: number; z: number; r: number }
export interface Spread { n: number; meanNearest: number; overlaps: number }

export function layoutSpread(points: readonly SpreadPoint[]): Spread {
  const n = points.length;
  if (n < 2) return { n, meanNearest: 0, overlaps: 0 };
  let sum = 0, overlaps = 0;
  const nearest = new Array<number>(n).fill(Infinity);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y, points[i].z - points[j].z);
      if (d < nearest[i]) nearest[i] = d;
      if (d < nearest[j]) nearest[j] = d;
      if (d < points[i].r + points[j].r) overlaps++;
    }
  }
  for (const d of nearest) sum += d;
  return { n, meanNearest: sum / n, overlaps };
}

/** The attribute text: stable and parseable (`n=12 nn=3.412 overlap=0`). */
export const formatSpread = (s: Spread): string => `n=${s.n} nn=${s.meanNearest.toFixed(3)} overlap=${s.overlaps}`;
