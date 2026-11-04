/**
 * A robust extent for Gaussian centres (F58.9.11 / kb:splat-compression).
 *
 * WHY. A reconstructed room is trained from photos, and the trainer leaves "floaters": a few
 * Gaussians far from anything real. Measured 2026-10-14 on a real iPhone scan (a private capture,
 * not in the repository): 228,275 Gaussians whose bounding box was 378.96 units long against about
 * 39 for a synthetic room of the same size. A viewer that fits the room to the bounding box shrinks
 * the whole room to make space for a handful of specks, so the walls come out tiny and blurry.
 *
 * The box here is the 1st to 99th percentile of the centres on each axis, grown by a margin so a
 * wall that holds a few percent of the points is not clipped, and never larger than the true box.
 * It is a rule of thumb, not a segmentation: it assumes under about 1% of the Gaussians per side
 * are strays, and a room that really is a long thin corridor with all its content at one end will
 * be mis-sized (the box is the room's bulk, not its reach). The unit tests plant outliers on
 * synthetic points; nothing here has been judged against a variety of real scans.
 */

export interface Box { min: [number, number, number]; max: [number, number, number] }

export interface RobustExtent {
  /** The box of the bulk of the Gaussians, margin included, inside the raw box. */
  box: Box;
  /** The longest side of `box`. */
  extent: number;
  /** The raw bounding box of every centre given, strays included. */
  rawBox: Box;
  /** The longest side of `rawBox`. */
  rawExtent: number;
  /** How many of the centres lie outside `box`. */
  outside: number;
  /** Centres examined. */
  count: number;
}

export interface RobustOptions {
  /** Lower percentile, 0..1 (default 0.01). */
  lo?: number;
  /** Upper percentile, 0..1 (default 0.99). */
  hi?: number;
  /** Margin added each side, as a fraction of the percentile span (default 0.1). */
  margin?: number;
}

function percentile(sorted: Float32Array, q: number): number {
  if (sorted.length === 0) return 0;
  const at = Math.min(sorted.length - 1, Math.max(0, q * (sorted.length - 1)));
  const i = Math.floor(at), f = at - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[i];
}

/** `centres` is x y z triples. Non-finite values are ignored. Returns null if no usable centre. */
export function robustExtent(centres: ArrayLike<number>, opts: RobustOptions = {}): RobustExtent | null {
  const { lo = 0.01, hi = 0.99, margin = 0.1 } = opts;
  const n = Math.floor(centres.length / 3);
  const axes = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  let used = 0;
  const rawMin = [Infinity, Infinity, Infinity], rawMax = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const x = centres[i * 3], y = centres[i * 3 + 1], z = centres[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    axes[0][used] = x; axes[1][used] = y; axes[2][used] = z; used++;
    if (x < rawMin[0]) rawMin[0] = x; if (x > rawMax[0]) rawMax[0] = x;
    if (y < rawMin[1]) rawMin[1] = y; if (y > rawMax[1]) rawMax[1] = y;
    if (z < rawMin[2]) rawMin[2] = z; if (z > rawMax[2]) rawMax[2] = z;
  }
  if (used === 0) return null;
  const min: number[] = [], max: number[] = [];
  for (let k = 0; k < 3; k++) {
    const sorted = axes[k].subarray(0, used).sort();
    const a = percentile(sorted, lo), b = percentile(sorted, hi);
    const pad = (b - a) * margin;
    min.push(Math.max(rawMin[k], a - pad));
    max.push(Math.min(rawMax[k], b + pad));
  }
  const box: Box = { min: min as Box['min'], max: max as Box['max'] };
  const rawBox: Box = { min: rawMin as Box['min'], max: rawMax as Box['max'] };
  let outside = 0;
  for (let i = 0; i < n; i++) {
    const x = centres[i * 3], y = centres[i * 3 + 1], z = centres[i * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    if (x < min[0] || x > max[0] || y < min[1] || y > max[1] || z < min[2] || z > max[2]) outside++;
  }
  const longest = (b: Box) => Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
  return { box, extent: longest(box), rawBox, rawExtent: longest(rawBox), outside, count: used };
}
