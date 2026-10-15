import { describe, expect, it } from 'vitest';
import type { OdometryRow } from '../scan-room-lib';
import {
  blurMetrics, buildTips, exposureMetrics, jerkMetrics, laplacianVariance, motionSamples, percentile,
  QUALITY_THRESHOLDS, registeredShare, speedMetrics, yawCoverage, type QualityMetrics,
} from '../scan-quality-lib';

// Synthetic odometry only: nothing here comes from a real capture.
const HZ = 30;

/** Build rows at HZ from a motion function: t -> { x, yawDeg }. Position moves along x; yaw turns about y. */
function synth(seconds: number, motion: (t: number) => { x: number; yawDeg: number }): OdometryRow[] {
  const rows: OdometryRow[] = [];
  const n = Math.round(seconds * HZ);
  for (let i = 0; i <= n; i++) {
    const t = i / HZ;
    const { x, yawDeg } = motion(t);
    const half = (yawDeg * Math.PI / 180) / 2;
    rows.push({
      timestamp: 1000 + t,
      frame: i,
      position: [x, 0, 0],
      quaternion: [0, Math.sin(half), 0, Math.cos(half)],
    });
  }
  return rows;
}

// A careful sweep: 0.3 m/s forward, one full turn over 60 s (6 deg/s), constant velocity throughout.
const slowSmooth = synth(60, (t) => ({ x: 0.3 * t, yawDeg: 6 * t }));

// A hurried, stop-go sweep: 1.6 m/s and 120 deg/s in bursts, switching every 0.4 s, so it starts and stops abruptly.
const fastJerky = (() => {
  let x = 0, yaw = 0;
  const rows: OdometryRow[] = [];
  const n = 60 * HZ;
  for (let i = 0; i <= n; i++) {
    const t = i / HZ;
    const burst = Math.floor(t / 0.4) % 2 === 0;
    if (i > 0) {
      x += (burst ? 1.6 : 0) / HZ;
      yaw += (burst ? 120 : 0) / HZ;
    }
    const half = (yaw * Math.PI / 180) / 2;
    rows.push({ timestamp: 1000 + t, frame: i, position: [x, 0, 0], quaternion: [0, Math.sin(half), 0, Math.cos(half)] });
  }
  return rows;
})();

describe('percentile', () => {
  it('interpolates between sorted values', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([], 50)).toBeNaN();
  });
});

describe('speed', () => {
  it('reads the slow path as about 0.3 m/s and 6 deg/s', () => {
    const s = motionSamples(slowSmooth);
    const lin = speedMetrics(s, 'linearMps', QUALITY_THRESHOLDS.linearMps);
    const ang = speedMetrics(s, 'angularDegPerS', QUALITY_THRESHOLDS.angularDegPerS);
    expect(lin.median).toBeCloseTo(0.3, 1);
    expect(ang.median).toBeCloseTo(6, 0);
    expect(ang.secondsAbove).toBe(0);
  });

  it('reads the hurried path as over both limits for many seconds', () => {
    const s = motionSamples(fastJerky);
    const ang = speedMetrics(s, 'angularDegPerS', QUALITY_THRESHOLDS.angularDegPerS);
    const lin = speedMetrics(s, 'linearMps', QUALITY_THRESHOLDS.linearMps);
    expect(ang.secondsAbove).toBeGreaterThan(20);
    expect(lin.secondsAbove).toBeGreaterThan(20);
    expect(ang.peak).toBeGreaterThan(100);
  });

  it('skips gaps in odometry rather than reading them as slow motion', () => {
    const rows = synth(2, () => ({ x: 0, yawDeg: 0 }));
    rows.push({ ...rows[rows.length - 1], timestamp: rows[rows.length - 1].timestamp + 5 });
    expect(motionSamples(rows).every((s) => s.dt <= 0.5)).toBe(true);
  });
});

describe('jerk', () => {
  it('is near zero on constant motion and large on stop-go motion', () => {
    const smooth = jerkMetrics(slowSmooth);
    const jerky = jerkMetrics(fastJerky);
    expect(smooth).not.toBeNull();
    expect(jerky).not.toBeNull();
    expect(smooth!.p95).toBeLessThan(1);
    expect(jerky!.p95).toBeGreaterThan(QUALITY_THRESHOLDS.jerkP95Mps3);
  });
});

describe('yaw coverage', () => {
  it('finds all 12 bins for a full turn and none empty', () => {
    const c = yawCoverage(slowSmooth);
    expect(c.bins).toHaveLength(12);
    expect(c.empty).toBe(0);
  });

  it('counts empty bins when the camera only faces one way', () => {
    const facing = synth(10, () => ({ x: 0, yawDeg: 10 }));
    const c = yawCoverage(facing);
    expect(c.covered).toBe(1);
    expect(c.empty).toBe(11);
  });
});

describe('blur and exposure', () => {
  it('scores a flat frame as zero variance and a checkerboard as high', () => {
    const w = 16, h = 16;
    const flat = new Uint8Array(w * h).fill(128);
    const check = new Uint8Array(w * h).map((_, i) => (((i % w) + Math.floor(i / w)) % 2 ? 255 : 0));
    expect(laplacianVariance(flat, w, h)).toBe(0);
    expect(laplacianVariance(check, w, h)).toBeGreaterThan(QUALITY_THRESHOLDS.blurVariance);
  });

  it('reports the share of blurry frames and the brightness spread', () => {
    expect(blurMetrics([10, 20, 500, 600]).belowShare).toBe(0.5);
    expect(exposureMetrics([100, 100, 100]).spread).toBe(0);
    expect(exposureMetrics([50, 200]).spread).toBeCloseTo(75, 0);
  });
});

describe('registered share and tips', () => {
  it('compares registered frames with kept frames', () => {
    expect(registeredShare(266, 300)).toBeCloseTo(0.887, 3);
    expect(registeredShare(0, 0)).toBeNaN();
  });

  it('gives no tips for the careful sweep', () => {
    const m: QualityMetrics = {
      source: 'synthetic-slow', durationS: 60,
      speed: { linear: speedMetrics(motionSamples(slowSmooth), 'linearMps', 0.8), angular: speedMetrics(motionSamples(slowSmooth), 'angularDegPerS', 45) },
      jerk: jerkMetrics(slowSmooth),
      coverage: { ...yawCoverage(slowSmooth), pathLengthM: 18 },
    };
    expect(buildTips(m)).toEqual([]);
  });

  it('gives tips for the hurried sweep, and they differ from the careful one', () => {
    const m: QualityMetrics = {
      source: 'synthetic-fast', durationS: 60,
      speed: { linear: speedMetrics(motionSamples(fastJerky), 'linearMps', 0.8), angular: speedMetrics(motionSamples(fastJerky), 'angularDegPerS', 45) },
      jerk: jerkMetrics(fastJerky),
      coverage: { ...yawCoverage(fastJerky), pathLengthM: 48 },
    };
    const tips = buildTips(m);
    expect(tips.length).toBeGreaterThanOrEqual(3);
    expect(tips.some((t) => t.includes('°/s for'))).toBe(true);
    expect(tips.some((t) => t.includes('m/s for'))).toBe(true);
    expect(tips.some((t) => t.includes('smooth sweep'))).toBe(true);
    expect(buildTips(m)).not.toEqual(buildTips({ source: 'x', durationS: 1, speed: undefined }));
  });

  it('gives one tip per metric over its threshold, including the registration tip', () => {
    const tips = buildTips({ source: 'x', durationS: 1, registeredShare: 0.2 });
    expect(tips).toHaveLength(1);
    expect(tips[0]).toContain('20%');
  });
});
