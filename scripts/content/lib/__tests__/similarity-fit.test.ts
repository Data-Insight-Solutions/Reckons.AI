// @vitest-environment node
/**
 * F58.9.19.2 (kb:fusion-metric-frame) — the fit at the heart of the metric frame.
 * Synthetic points only, seeded so the numbers never move between runs; no capture,
 * no device, no real data (the graph's rule for these tests).
 */
import { describe, expect, it } from 'vitest';
import {
  fitSimilarity,
  fitSimilarityRobust,
  medianScale,
  type Vec3,
} from '../similarity-fit';

const DEG = Math.PI / 180;

/** mulberry32: a deterministic PRNG, so the synthetic clouds are the same on every run. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rotation of `theta` about the x axis, row-major. */
function rotX(theta: number): number[] {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function apply(m: number[], v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** Angle between two vectors, in radians. */
function angleBetween(a: Vec3, b: Vec3): number {
  const la = Math.hypot(a[0], a[1], a[2]);
  const lb = Math.hypot(b[0], b[1], b[2]);
  const d = Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)));
  return Math.acos(d);
}

// The ground truth this stage must recover: scale 2.5, a 20° tilt about x, a known shift.
const SCALE = 2.5;
const R = rotX(20 * DEG);
const SHIFT: Vec3 = [0.7, -1.3, 4.2];

function makePair(n: number, seed: number): { source: Vec3[]; target: Vec3[] } {
  const rnd = mulberry32(seed);
  const source: Vec3[] = [];
  for (let i = 0; i < n; i++) source.push([rnd() * 4 - 2, rnd() * 4 - 2, rnd() * 4 - 2]);
  const target = source.map((p) => {
    const q = apply(R, p);
    return [SCALE * q[0] + SHIFT[0], SCALE * q[1] + SHIFT[1], SCALE * q[2] + SHIFT[2]] as Vec3;
  });
  return { source, target };
}

describe('fitSimilarity', () => {
  it('recovers the known scale of 2.5 within 1 percent', () => {
    const { source, target } = makePair(50, 42);
    const fit = fitSimilarity(source, target);
    expect(Math.abs(fit.scale - SCALE) / SCALE).toBeLessThan(0.01);
  });

  it('recovers the known tilt: the up direction lands within 1 degree', () => {
    const { source, target } = makePair(50, 42);
    const fit = fitSimilarity(source, target);
    const up: Vec3 = [0, 1, 0];
    expect(angleBetween(apply(fit.rotation, up), apply(R, up))).toBeLessThan(1 * DEG);
  });

  it('recovers the known shift and leaves an exact cloud at machine-precision error', () => {
    const { source, target } = makePair(50, 42);
    const fit = fitSimilarity(source, target);
    fit.translation.forEach((c, i) => expect(Math.abs(c - SHIFT[i])).toBeLessThan(1e-6));
    const rotationError = Math.max(...fit.rotation.map((v, i) => Math.abs(v - R[i])));
    expect(rotationError).toBeLessThan(1e-6);
    expect(fit.rmse).toBeLessThan(1e-6);
  });

  it('returns a proper rotation: orthonormal, determinant +1', () => {
    const { source, target } = makePair(50, 7);
    const { rotation: m } = fitSimilarity(source, target);
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++) {
        let dot = 0;
        for (let k = 0; k < 3; k++) dot += m[i * 3 + k] * m[j * 3 + k];
        expect(dot).toBeCloseTo(i === j ? 1 : 0, 9);
      }
    const det =
      m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
    expect(det).toBeCloseTo(1, 9);
  });

  it('refuses input it cannot pair or that carries no information', () => {
    expect(() => fitSimilarity([[0, 0, 0], [1, 1, 1]], [[0, 0, 0]])).toThrow(/match/);
    expect(() => fitSimilarity([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]])).toThrow(/at least 3/);
    const collapsed: Vec3[] = [[1, 1, 1], [1, 1, 1], [1, 1, 1]];
    expect(() => fitSimilarity(collapsed, collapsed)).toThrow(/collapse/);
    expect(() => fitSimilarity([[NaN, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]])).toThrow(
      /finite/,
    );
  });
});

describe('fitSimilarityRobust', () => {
  it('with 10 percent of the target points corrupted, stays within 2 percent and keeps near 90 percent', () => {
    const { source, target } = makePair(50, 42);
    const corrupted = target.map((p, i) =>
      i < 5 ? ([p[0] + 60, p[1] - 40, p[2] + 50] as Vec3) : p, // 5 of 50 = 10%
    );
    const fit = fitSimilarityRobust(source, corrupted);
    expect(Math.abs(fit.scale - SCALE) / SCALE).toBeLessThan(0.02);
    expect(fit.keptShare).toBeGreaterThanOrEqual(0.85);
    expect(fit.keptShare).toBeLessThanOrEqual(0.95);
    expect(fit.rmse).toBeLessThan(0.1);
  });

  it('drops nothing on an exact cloud and reports a full kept share', () => {
    const { source, target } = makePair(50, 9);
    const fit = fitSimilarityRobust(source, target);
    expect(fit.keptShare).toBe(1);
    expect(Math.abs(fit.scale - SCALE) / SCALE).toBeLessThan(0.01);
  });
});

describe('medianScale', () => {
  it('reports a corrupted estimate as an outlier and leaves it out of the median', () => {
    const res = medianScale([2.5, 2.48, 2.52, 2.51, 8.3]);
    expect(res.outliers).toEqual([4]);
    expect(res.kept).toEqual([0, 1, 2, 3]);
    // The median is computed from the kept estimates only: 8.3 never enters it.
    expect(res.median).toBeCloseTo(2.505, 6);
    expect(Math.abs(res.median - 2.5) / 2.5).toBeLessThan(0.01);
  });

  it('keeps every estimate within 20 percent of the median', () => {
    const res = medianScale([1, 1.1, 0.9]);
    expect(res.outliers).toEqual([]);
    expect(res.median).toBeCloseTo(1, 6);
  });

  it('keeps everything when the set splits and every estimate outruns the band', () => {
    const res = medianScale([0.5, 1.5, 0.5, 1.5]);
    expect(res.outliers).toEqual([]);
    expect(res.median).toBeCloseTo(1, 6);
  });

  it('refuses an empty list', () => {
    expect(() => medianScale([])).toThrow(/no estimates/);
  });
});
