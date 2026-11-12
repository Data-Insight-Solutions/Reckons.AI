/**
 * F58.9.19.2 (kb:fusion-metric-frame) — the fit at the heart of the metric frame.
 *
 * The fused layout has no scale and no up; the phone's motion record has both, per capture.
 * For each capture we fit the ONE transform (a scale, a rotation, a translation) that best
 * lays the layout's camera positions onto the phone's, in the least-squares sense, ignoring
 * the points that disagree. This file is the pure math of that fit — no pipeline wiring,
 * no receipts, no COLMAP. The receipt numbers (scale, leftover error in centimeters, the
 * share that agrees, how far the scale estimates spread) are derived from these functions
 * by a later stage.
 *
 * Method: Horn's closed-form quaternion solution of the absolute-orientation problem
 * (K. A. Horn, "Closed-form solution of absolute orientation using unit quaternions",
 * J. Opt. Soc. Am. A 1987): the best rotation maximizes trace(B'ᵀ R A'), which as a
 * function of the unit quaternion q is the Rayleigh quotient qᵀ Q q, so the answer is the
 * eigenvector of the symmetric 4×4 matrix Q with the largest eigenvalue. The eigenvalue
 * problem is solved here with a small cyclic Jacobi eigensolver, written in this file on
 * purpose — no new dependency.
 *
 * FIRST DRAFT, 2026-11-10, for an overseer to review.
 */

export type Vec3 = readonly [number, number, number];

export interface SimilarityFit {
  /** The scale s, from target ≈ s · rotation · source + translation. */
  scale: number;
  /** 3×3 rotation matrix, row-major, nine entries. Orthonormal, determinant +1. */
  rotation: number[];
  /** The translation t. */
  translation: Vec3;
  /** Root-mean-square of |target_i − (s · R · source_i + t)| over the fitted pairs. */
  rmse: number;
  /** Number of pairs fitted. */
  n: number;
}

export interface RobustFit extends SimilarityFit {
  /** Share of the input pairs still in after outlier rejection (kept / total). */
  keptShare: number;
  /** Number of pairs still in after outlier rejection. */
  kept: number;
  /** Fits actually computed (the initial one plus each refit); at most `maxRounds`. */
  rounds: number;
}

export interface MedianScaleResult {
  /** Median of the kept estimates only. */
  median: number;
  /** Indices of the estimates kept (within 20% of the initial median). */
  kept: number[];
  /** Indices of the estimates more than 20% from the initial median — reported, and left out. */
  outliers: number[];
}

/* ── small linear algebra, kept in this file on purpose (no dependency) ──────────────── */

function isFiniteVec3(v: unknown, where: string): asserts v is Vec3 {
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    !(v[0] === v[0] && v[1] === v[1] && v[2] === v[2]) ||
    !isFinite(v[0]) || !isFinite(v[1]) || !isFinite(v[2])
  )
    throw new Error(`similarity-fit: ${where} is not a finite 3-point vector`);
}

function validatePairs(source: readonly unknown[], target: readonly unknown[], name: string): void {
  if (!Array.isArray(source) || !Array.isArray(target))
    throw new Error(`${name}: source and target must be arrays of points`);
  if (source.length !== target.length)
    throw new Error(`${name}: ${source.length} source points vs ${target.length} target points — the pairs must match`);
  if (source.length < 3)
    throw new Error(`${name}: at least 3 point pairs are needed to fit a 3D similarity transform`);
  for (let i = 0; i < source.length; i++) {
    isFiniteVec3(source[i], `source[${i}]`);
    isFiniteVec3(target[i], `target[${i}]`);
  }
}

/** Rotation matrix from a unit quaternion [w, x, y, z]. */
function rotationFromQuaternion(w: number, x: number, y: number, z: number): number[] {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

/**
 * Cyclic Jacobi eigensolver for a real symmetric matrix; returns the eigenvalue with the
 * LARGEST value and its eigenvector (the Rayleigh quotient's maximizer, which is what
 * Horn's method needs — largest by value, not by magnitude).
 */
function largestEigen(matrix: number[][]): { eigenvalue: number; eigenvector: number[] } {
  const n = matrix.length;
  const m = matrix.map((row) => [...row]);
  const v: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
  );
  for (let sweep = 0; sweep < 60; sweep++) {
    let p = 0;
    let q = 1;
    let largest = 0;
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++)
        if (Math.abs(m[i][j]) > largest) {
          largest = Math.abs(m[i][j]);
          p = i;
          q = j;
        }
    let diagSum = 0;
    for (let i = 0; i < n; i++) diagSum += Math.abs(m[i][i]);
    if (largest <= 1e-14 * Math.max(1, diagSum)) break;
    const app = m[p][p];
    const aqq = m[q][q];
    const apq = m[p][q];
    const theta = (aqq - app) / (2 * apq);
    const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
    const c = 1 / Math.sqrt(t * t + 1);
    const s = t * c;
    for (let k = 0; k < n; k++) {
      if (k === p || k === q) continue;
      const akp = m[k][p];
      const akq = m[k][q];
      m[k][p] = m[p][k] = c * akp - s * akq;
      m[k][q] = m[q][k] = s * akp + c * akq;
    }
    m[p][p] = app - t * apq;
    m[q][q] = aqq + t * apq;
    m[p][q] = m[q][p] = 0;
    for (let k = 0; k < n; k++) {
      const vkp = v[k][p];
      const vkq = v[k][q];
      v[k][p] = c * vkp - s * vkq;
      v[k][q] = s * vkp + c * vkq;
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (m[i][i] > m[best][best]) best = i;
  return { eigenvalue: m[best][best], eigenvector: v.map((row) => row[best]) };
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* ── the fit ──────────────────────────────────────────────────────────────────────────── */

/**
 * Least-squares similarity transform taking `source` onto `target`:
 * target ≈ scale · rotation · source + translation.
 *
 * Horn's closed form. Throws on input that cannot be paired, on a collapsed source
 * (no scale is determined), and when the best fit would be a reflection rather than a
 * rotation — that is data telling us the frames disagree in chirality, which is worth
 * hearing about rather than averaging past.
 */
export function fitSimilarity(source: readonly Vec3[], target: readonly Vec3[]): SimilarityFit {
  validatePairs(source, target, 'fitSimilarity');
  const n = source.length;

  // Centroids, then the centered point clouds.
  const aBar: Vec3 = [0, 0, 0];
  const bBar: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++)
    for (let k = 0; k < 3; k++) {
      aBar[k] += source[i][k];
      bBar[k] += target[i][k];
    }
  for (let k = 0; k < 3; k++) {
    aBar[k] /= n;
    bBar[k] /= n;
  }
  const aC = source.map((p) => [p[0] - aBar[0], p[1] - aBar[1], p[2] - aBar[2]] as Vec3);
  const bC = target.map((p) => [p[0] - bBar[0], p[1] - bBar[1], p[2] - bBar[2]] as Vec3);

  // Cross-covariance N = A'ᵀB' (N[r][c] = Σ a'_r · b'_c) and the source's squared radius
  // (the scale denominator). With N in this order, the largest-eigenvalue eigenvector of
  // the Horn matrix below is the quaternion of the rotation that takes A onto B; the
  // transposed order returns its inverse (found that way: a 20° tilt about x came back
  // at −20° until the order was fixed).
  const N = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  let radiusSq = 0;
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) N[r][c] += aC[i][r] * bC[i][c];
    radiusSq += aC[i][0] ** 2 + aC[i][1] ** 2 + aC[i][2] ** 2;
  }
  if (radiusSq <= 0)
    throw new Error('fitSimilarity: the source points collapse to one place, so no scale is determined');

  // Horn's symmetric 4×4 matrix Q, whose largest-eigenvalue eigenvector is the answer.
  const Q = [
    [
      N[0][0] + N[1][1] + N[2][2],
      N[1][2] - N[2][1],
      N[2][0] - N[0][2],
      N[0][1] - N[1][0],
    ],
    [
      N[1][2] - N[2][1],
      N[0][0] - N[1][1] - N[2][2],
      N[0][1] + N[1][0],
      N[2][0] + N[0][2],
    ],
    [
      N[2][0] - N[0][2],
      N[0][1] + N[1][0],
      -N[0][0] + N[1][1] - N[2][2],
      N[1][2] + N[2][1],
    ],
    [
      N[0][1] - N[1][0],
      N[2][0] + N[0][2],
      N[1][2] + N[2][1],
      -N[0][0] - N[1][1] + N[2][2],
    ],
  ];
  const { eigenvector } = largestEigen(Q);
  const norm = Math.hypot(eigenvector[0], eigenvector[1], eigenvector[2], eigenvector[3]);
  const [w, x, y, z] = eigenvector.map((e) => e / norm);
  const rotation = rotationFromQuaternion(w, x, y, z);

  // Scale from trace(B'ᵀ R A') / trace(A'ᵀA'); translation from the centroid equation.
  let num = 0;
  for (let i = 0; i < n; i++) {
    const ra = applyRowMajor3(rotation, aC[i]);
    num += bC[i][0] * ra[0] + bC[i][1] * ra[1] + bC[i][2] * ra[2];
  }
  const scale = num / radiusSq;
  if (!(scale > 0))
    throw new Error(
      `fitSimilarity: the best fit is a reflection (scale ${scale}), not a rotation — the two frames disagree in chirality`,
    );
  const rAbar = applyRowMajor3(rotation, aBar);
  const translation: Vec3 = [
    bBar[0] - scale * rAbar[0],
    bBar[1] - scale * rAbar[1],
    bBar[2] - scale * rAbar[2],
  ];
  return { scale, rotation, translation, rmse: residualRmse(source, target, scale, rotation, translation), n };
}

function applyRowMajor3(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

function residualRmse(
  source: readonly Vec3[],
  target: readonly Vec3[],
  scale: number,
  rotation: number[],
  translation: Vec3,
): number {
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    const p = applyRowMajor3(rotation, source[i]);
    const e0 = target[i][0] - (scale * p[0] + translation[0]);
    const e1 = target[i][1] - (scale * p[1] + translation[1]);
    const e2 = target[i][2] - (scale * p[2] + translation[2]);
    sum += e0 * e0 + e1 * e1 + e2 * e2;
  }
  return Math.sqrt(sum / source.length);
}

/**
 * The fit with outlier rejection: fit, drop every pair whose residual is more than 3× the
 * median residual, refit — at most `maxRounds` fits in all. The fit stops early when
 * nothing is left to drop, or when the residuals are down at floating-point noise level
 * (there, the median is a measurement of the machine, not of the data, and dropping by
 * it would remove points at random).
 */
export function fitSimilarityRobust(
  source: readonly Vec3[],
  target: readonly Vec3[],
  maxRounds: number = 5,
): RobustFit {
  validatePairs(source, target, 'fitSimilarityRobust');
  const n = source.length;

  let extent = 1;
  for (let i = 0; i < n; i++) {
    extent = Math.max(extent, Math.hypot(...source[i]), Math.hypot(...target[i]));
  }
  const noiseFloor = 1e-9 * extent;

  let kept = Array.from({ length: n }, (_, i) => i);
  let fit = fitSimilarity(pick(source, kept), pick(target, kept));
  let rounds = 1;
  for (let round = 2; round <= maxRounds; round++) {
    const residuals = kept.map((i) => {
      const p = applyRowMajor3(fit.rotation, source[i]);
      const e0 = target[i][0] - (fit.scale * p[0] + fit.translation[0]);
      const e1 = target[i][1] - (fit.scale * p[1] + fit.translation[1]);
      const e2 = target[i][2] - (fit.scale * p[2] + fit.translation[2]);
      return Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2);
    });
    const med = median(residuals);
    if (med <= noiseFloor) break;
    const threshold = 3 * med;
    const nextKept = kept.filter((_, k) => residuals[k] <= threshold);
    if (nextKept.length === kept.length) break;
    if (nextKept.length < 3) break; // never thin a 3D fit below three points
    kept = nextKept;
    fit = fitSimilarity(pick(source, kept), pick(target, kept));
    rounds = round;
  }
  return { ...fit, keptShare: kept.length / n, kept: kept.length, rounds };
}

function pick<T>(xs: readonly T[], kept: number[]): T[] {
  return kept.map((i) => xs[i]);
}

/**
 * The median of the per-capture scale estimates. Any estimate more than 20% from that
 * median is reported as an outlier and left OUT of the returned median — a corrupted
 * motion record must not be averaged into the frame's meters (kb:fusion-metric-frame's
 * done-test). The band is judged against the first median so the rule is the same one a
 * person could check by hand.
 */
export function medianScale(estimates: readonly number[]): MedianScaleResult {
  if (!Array.isArray(estimates) || estimates.length === 0)
    throw new Error('medianScale: no estimates given');
  for (let i = 0; i < estimates.length; i++)
    if (typeof estimates[i] !== 'number' || !isFinite(estimates[i]))
      throw new Error(`medianScale: estimates[${i}] is not a finite number`);
  const first = median([...estimates]);
  if (first <= 0) {
    // Non-positive scales are not a band question — nothing to 20% off of. Report them as they are.
    return { median: first, kept: estimates.map((_, i) => i), outliers: [] };
  }
  const band = 0.2 * first;
  const kept: number[] = [];
  const outliers: number[] = [];
  estimates.forEach((e, i) => (Math.abs(e - first) > band ? outliers : kept).push(i));
  if (kept.length === 0)
    // Every estimate outran the band (possible when the set splits in two). Then the
    // median itself is the only honest number, and the split is visible in the spread.
    return { median: first, kept: estimates.map((_, i) => i), outliers: [] };
  return { median: median(kept.map((i) => estimates[i])), kept, outliers };
}
