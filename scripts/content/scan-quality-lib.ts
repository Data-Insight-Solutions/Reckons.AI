/**
 * Pure metrics and coaching tips for a room scan (F58.9.14 / kb:scan-quality).
 * No file, ffmpeg or network access here, so the tests run anywhere; scripts/content/scan-quality.ts
 * reads the odometry and the video and calls these functions.
 *
 * Quality, per Matt (2026-10-14): a phone scan is limited by how fast the person moves, how steadily
 * they move, and which angles they capture. A room cannot be prepared the way a small object can.
 */
import { pathLength, type OdometryRow } from './scan-room-lib.js';

/**
 * FIRST GUESSES. None of these numbers has been measured against scans that people rated good or bad.
 * Replace each one from measured scans (scan:quality on several captures) before trusting a tip.
 */
export const QUALITY_THRESHOLDS = {
  /** Linear speed of the phone, metres per second. Tip when above this for longer than maxSecondsAbove. */
  linearMps: 0.8,
  /** Angular speed of the phone, degrees per second. */
  angularDegPerS: 45,
  /** Seconds allowed above either speed limit before a tip is given. */
  maxSecondsAbove: 2,
  /** 95th percentile of jerk (third derivative of position, m/s^3). Above this, motion is jerky. */
  jerkP95Mps3: 20,
  /** Yaw bin width in degrees. 30 gives 12 bins around the room. */
  yawBinDeg: 30,
  /** Empty yaw bins allowed before a tip is given. */
  maxEmptyYawBins: 3,
  /** Laplacian variance of a 480-wide greyscale frame below this counts as blurry. */
  blurVariance: 100,
  /** Share of sampled frames allowed to be blurry. */
  maxBlurShare: 0.2,
  /** Standard deviation of per-frame mean brightness (0 to 255) allowed before a tip is given. */
  maxBrightnessSpread: 30,
  /** Minimum share of kept frames that COLMAP registered (matches scan-room-lib MIN_REGISTERED_FRACTION). */
  minRegisteredShare: 0.5,
} as const;

export type Thresholds = typeof QUALITY_THRESHOLDS;

/** One interval between consecutive odometry rows. */
export interface MotionSample {
  /** Interval length in seconds. */
  dt: number;
  linearMps: number;
  angularDegPerS: number;
}

/** Intervals longer than this (a dropped-odometry gap) are skipped rather than read as slow motion. */
const MAX_GAP_S = 0.5;

export function percentile(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const pos = (p / 100) * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Linear and angular speed between each pair of consecutive odometry rows. */
export function motionSamples(rows: OdometryRow[]): MotionSample[] {
  const out: MotionSample[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    const dt = b.timestamp - a.timestamp;
    if (!(dt > 0 && dt <= MAX_GAP_S)) continue;
    const dist = Math.hypot(...b.position.map((p, k) => p - a.position[k]));
    const dot = Math.abs(a.quaternion.reduce((s, q, k) => s + q * b.quaternion[k], 0));
    const angle = 2 * Math.acos(Math.min(1, dot)); // radians between the two orientations
    out.push({ dt, linearMps: dist / dt, angularDegPerS: (angle * 180 / Math.PI) / dt });
  }
  return out;
}

export interface SpeedMetrics {
  median: number;
  p95: number;
  peak: number;
  /** Seconds spent above the threshold. */
  secondsAbove: number;
  /** Total seconds of motion measured. */
  totalSeconds: number;
}

export function speedMetrics(samples: MotionSample[], key: 'linearMps' | 'angularDegPerS', threshold: number): SpeedMetrics {
  const v = samples.map((s) => s[key]);
  return {
    median: round(percentile(v, 50)),
    p95: round(percentile(v, 95)),
    peak: round(v.length ? Math.max(...v) : NaN),
    secondsAbove: round(samples.filter((s) => s[key] > threshold).reduce((t, s) => t + s.dt, 0)),
    totalSeconds: round(samples.reduce((t, s) => t + s.dt, 0)),
  };
}

export interface JerkMetrics { median: number; p95: number }

/**
 * Smoothness. Position is differenced over `stride` rows first: at 30 Hz, millimetre noise in
 * odometry would dominate a raw third difference. Returns null when there are too few rows.
 */
export function jerkMetrics(rows: OdometryRow[], stride = 5): JerkMetrics | null {
  // Velocity: position difference over `stride` rows, stamped at the midpoint.
  const vel: { t: number; v: number[] }[] = [];
  for (let i = 0; i + stride < rows.length; i++) {
    const a = rows[i], b = rows[i + stride];
    const dt = b.timestamp - a.timestamp;
    if (!(dt > 0 && dt <= MAX_GAP_S * stride)) continue;
    vel.push({ t: (a.timestamp + b.timestamp) / 2, v: b.position.map((p, k) => (p - a.position[k]) / dt) });
  }
  // Acceleration: difference of consecutive velocities. Jerk: difference of consecutive accelerations.
  const acc: { t: number; a: number[] }[] = [];
  for (let i = 1; i < vel.length; i++) {
    const dt = vel[i].t - vel[i - 1].t;
    if (dt > 0) acc.push({ t: (vel[i].t + vel[i - 1].t) / 2, a: vel[i].v.map((v, k) => (v - vel[i - 1].v[k]) / dt) });
  }
  const jerk: number[] = [];
  for (let i = 1; i < acc.length; i++) {
    const dt = acc[i].t - acc[i - 1].t;
    if (dt > 0) jerk.push(Math.hypot(...acc[i].a.map((a, k) => (a - acc[i - 1].a[k]) / dt)));
  }
  if (jerk.length < 3) return null;
  return { median: round(percentile(jerk, 50)), p95: round(percentile(jerk, 95)) };
}

export interface YawCoverage {
  binDeg: number;
  bins: number[];
  empty: number;
  covered: number;
}

/** Forward (view) direction of a camera with this orientation, in the odometry's world axes. */
export function viewDirection(q: number[]): [number, number, number] {
  const [x, y, z, w] = q;
  // Rotate the camera's forward axis (0, 0, -1) by the unit quaternion.
  const f: [number, number, number] = [0, 0, -1];
  const u: [number, number, number] = [x, y, z];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const uf = cross(u, f);
  const uuf = cross(u, uf);
  return [0, 1, 2].map((k) => f[k] + 2 * w * uf[k] + 2 * uuf[k]) as [number, number, number];
}

/** How the camera's yaw (heading around the vertical axis) is spread across the scan. */
export function yawCoverage(rows: OdometryRow[], binDeg = QUALITY_THRESHOLDS.yawBinDeg): YawCoverage {
  const n = Math.round(360 / binDeg);
  const bins = new Array<number>(n).fill(0);
  for (const r of rows) {
    const [fx, , fz] = viewDirection(r.quaternion);
    let yaw = (Math.atan2(fx, fz) * 180) / Math.PI;
    if (yaw < 0) yaw += 360;
    bins[Math.min(n - 1, Math.floor(yaw / binDeg))]++;
  }
  const empty = bins.filter((c) => c === 0).length;
  return { binDeg, bins, empty, covered: n - empty };
}

export function totalPathLength(rows: OdometryRow[]): number {
  return round(pathLength(rows));
}

/** Variance of a 3x3 Laplacian over a greyscale frame (row-major, one byte per pixel). A standard blur score. */
export function laplacianVariance(grey: Uint8Array, width: number, height: number): number {
  let n = 0, sum = 0, sumSq = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const l = grey[i - width] + grey[i + width] + grey[i - 1] + grey[i + 1] - 4 * grey[i];
      sum += l; sumSq += l * l; n++;
    }
  }
  if (!n) return NaN;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function meanBrightness(grey: Uint8Array): number {
  if (!grey.length) return NaN;
  let s = 0;
  for (const v of grey) s += v;
  return s / grey.length;
}

export interface BlurMetrics { median: number; belowShare: number; frames: number }

export function blurMetrics(variances: number[], threshold = QUALITY_THRESHOLDS.blurVariance): BlurMetrics {
  const ok = variances.filter(Number.isFinite);
  return {
    median: round(percentile(ok, 50)),
    belowShare: ok.length ? round(ok.filter((v) => v < threshold).length / ok.length, 3) : NaN,
    frames: ok.length,
  };
}

export interface ExposureMetrics { mean: number; spread: number; min: number; max: number; frames: number }

/** Spread is the standard deviation of per-frame mean brightness, on a 0 to 255 scale. */
export function exposureMetrics(brightness: number[]): ExposureMetrics {
  const v = brightness.filter(Number.isFinite);
  if (!v.length) return { mean: NaN, spread: NaN, min: NaN, max: NaN, frames: 0 };
  const mean = v.reduce((s, x) => s + x, 0) / v.length;
  const variance = v.reduce((s, x) => s + (x - mean) ** 2, 0) / v.length;
  return { mean: round(mean), spread: round(Math.sqrt(variance)), min: round(Math.min(...v)), max: round(Math.max(...v)), frames: v.length };
}

export function registeredShare(registered: number, kept: number): number {
  return kept > 0 ? round(registered / kept, 3) : NaN;
}

export interface QualityMetrics {
  source: string;
  durationS: number | null;
  speed?: { linear: SpeedMetrics; angular: SpeedMetrics };
  jerk?: JerkMetrics | null;
  coverage?: YawCoverage & { pathLengthM: number };
  blur?: BlurMetrics;
  exposure?: ExposureMetrics;
  registeredShare?: number;
}

/**
 * One plain-language sentence per metric that is over its threshold, in the order a person would
 * fix them. A metric that is missing (no odometry, no receipt) gives no tip.
 */
export function buildTips(m: QualityMetrics, t: Thresholds = QUALITY_THRESHOLDS): string[] {
  const tips: string[] = [];
  if (m.speed) {
    const a = m.speed.angular;
    if (a.secondsAbove > t.maxSecondsAbove) {
      tips.push(`You turned faster than ${t.angularDegPerS}°/s for ${Math.round(a.secondsAbove)} s. Turn about half as fast.`);
    }
    const l = m.speed.linear;
    if (l.secondsAbove > t.maxSecondsAbove) {
      tips.push(`You moved faster than ${t.linearMps} m/s for ${Math.round(l.secondsAbove)} s. Walk about half as fast.`);
    }
  }
  if (m.jerk && m.jerk.p95 > t.jerkP95Mps3) {
    tips.push('Your movement starts and stops suddenly. Move in one smooth sweep and keep the phone steady.');
  }
  if (m.coverage && m.coverage.empty > t.maxEmptyYawBins) {
    tips.push(`You pointed the camera at only ${m.coverage.covered} of ${360 / m.coverage.binDeg} directions. Turn slowly through a full circle.`);
  }
  if (m.blur && m.blur.belowShare > t.maxBlurShare) {
    tips.push(`${Math.round(m.blur.belowShare * 100)}% of the frames were blurry. Slow down and hold the phone still while it records.`);
  }
  if (m.exposure && m.exposure.spread > t.maxBrightnessSpread) {
    tips.push('The brightness changed a lot from frame to frame. Keep the room lit evenly, and avoid walking from dark corners into bright windows.');
  }
  if (m.registeredShare !== undefined && m.registeredShare < t.minRegisteredShare) {
    tips.push(`Only ${Math.round(m.registeredShare * 100)}% of the frames could be placed in the scan. Move more slowly and overlap each view with the one before.`);
  }
  return tips;
}

function round(x: number, places = 2): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
