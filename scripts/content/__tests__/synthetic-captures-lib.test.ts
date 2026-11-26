import { describe, expect, it } from 'vitest';
import { frameName } from '../scan-multi-lib.js';
import { judgeRun, measure, mulMM, parseArgs, planCaptures, rng, rotationErrorDeg, umeyama, type Mat3, type RegisteredCamera, type TruePoses, type Vec3 } from '../synthetic-captures-lib.js';

const rotZ = (deg: number): Mat3 => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; };
const rotX = (deg: number): Mat3 => { const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t); return [[1, 0, 0], [0, c, -s], [0, s, c]]; };
const apply = (R: Mat3, v: Vec3, s = 1, t: Vec3 = [0, 0, 0]): Vec3 => [0, 1, 2].map((i) => s * (R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]) + t[i]) as Vec3;
const cloud = (n: number): Vec3[] => { const r = rng(3); return Array.from({ length: n }, () => [r() * 4 - 2, r() * 4 - 2, r() * 2]); };

describe('umeyama', () => {
  it('recovers a known rotation, scale and translation', () => {
    const R = mulMM(rotZ(37), rotX(-21));
    const from = cloud(30);
    const to = from.map((p) => apply(R, p, 2.5, [1, -2, 3]));
    const s = umeyama(from, to);
    expect(s.scale).toBeCloseTo(2.5, 9);
    expect(rotationErrorDeg(R, s.R)).toBeLessThan(1e-6);
    expect(s.t[0]).toBeCloseTo(1, 8); expect(s.t[1]).toBeCloseTo(-2, 8); expect(s.t[2]).toBeCloseTo(3, 8);
  });
  it('refuses too few points and coincident points', () => {
    expect(() => umeyama([[0, 0, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0]])).toThrow(/at least 3/);
    expect(() => umeyama([[1, 1, 1], [1, 1, 1], [1, 1, 1]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]])).toThrow(/same point/);
  });
});

describe('rotationErrorDeg', () => {
  it('is the angle between rotations', () => {
    expect(rotationErrorDeg(rotZ(10), rotZ(25))).toBeCloseTo(15, 9);
    expect(rotationErrorDeg(rotX(0), rotX(0))).toBeCloseTo(0, 9);
  });
});

// A truth of two captures; COLMAP's frame is the true frame moved by a similarity.
function world() {
  const centres = cloud(12);
  const frame = (cap: string, i: number): { R: Mat3; centre: Vec3; file: string } => ({ file: `${cap}${i}`, R: rotZ(i * 9), centre: centres[i + (cap === 'b' ? 6 : 0)] });
  const truth: TruePoses = { objectSize: 2, captures: ['a', 'b'].map((n) => ({ name: n, frames: Array.from({ length: 6 }, (_, i) => frame(n, i)) })) };
  // COLMAP frame x_c = (x_true - t)/s rotated by S^-1; build it as x_true = s*Rs*x_c + t
  const Rs = mulMM(rotZ(50), rotX(15)), s = 0.37, t: Vec3 = [4, 5, 6];
  const inv = (v: Vec3): Vec3 => { const w: Vec3 = [(v[0] - t[0]) / s, (v[1] - t[1]) / s, (v[2] - t[2]) / s]; return [0, 1, 2].map((i) => Rs[0][i] * w[0] + Rs[1][i] * w[1] + Rs[2][i] * w[2]) as Vec3; };
  const cams = (drop: string[] = [], jitter = 0): RegisteredCamera[] => truth.captures.flatMap((c) => c.frames.map((f, i) => ({ name: frameName(c.name, i + 1), R: mulMM(f.R, rotZ(jitter)), centre: inv(f.centre) }))).filter((c) => !drop.some((d) => c.name.startsWith(d)));
  // est R_w2c' with x_c frame: R_est = R_true * Rs  (so that R_est * Rs^T = R_true)
  const withFrame = (list: RegisteredCamera[]) => list.map((c) => ({ ...c, R: mulMM(c.R, Rs) }));
  return { truth, cams, withFrame };
}

describe('measure', () => {
  it('reports ~zero error and a joined model when COLMAP matches the truth up to a similarity', () => {
    const { truth, cams, withFrame } = world();
    const cs = withFrame(cams());
    const m = measure(truth, cs, [cs.map((c) => c.name)]);
    expect(m.allJoined).toBe(true);
    expect(m.captures.map((c) => c.registered)).toEqual([6, 6]);
    for (const c of m.captures) { expect(c.maxRotationDeg!).toBeLessThan(1e-5); expect(c.maxPositionShare!).toBeLessThan(1e-9); }
    expect(m.failures).toEqual([]);
  });
  it('reports a known rotation error', () => {
    const { truth, cams, withFrame } = world();
    const cs = withFrame(cams([], 3)); // every camera rotated 3 degrees about its own z
    const m = measure(truth, cs, [cs.map((c) => c.name)]);
    expect(m.captures[0].medianRotationDeg!).toBeCloseTo(3, 3);
  });
  it('reports a capture that is absent as not joined and exits through allJoined=false', () => {
    const { truth, cams, withFrame } = world();
    const cs = withFrame(cams(['b__']));
    const m = measure(truth, cs, [cs.map((c) => c.name)]);
    expect(m.allJoined).toBe(false);
    expect(m.captures[1]).toMatchObject({ registered: 0, joined: false, medianRotationDeg: null });
    expect(m.failures.join(' ')).toMatch(/capture "b" did not join/);
  });
  it('says so when too few cameras are registered to align', () => {
    const { truth, cams, withFrame } = world();
    const cs = withFrame(cams()).slice(0, 2);
    const m = measure(truth, cs, [cs.map((c) => c.name)]);
    expect(m.failures.join(' ')).toMatch(/needs 3/);
  });
});

describe('planCaptures and parseArgs', () => {
  const base = { seed: 7, captures: 3, frames: 20, width: 960, height: 540, samples: 24, objectSize: 2.6 };
  it('is deterministic per seed and differs between seeds', () => {
    expect(planCaptures(base)).toEqual(planCaptures(base));
    expect(planCaptures({ ...base, seed: 8 })).not.toEqual(planCaptures(base));
  });
  it('gives every capture its own path, lens and light, and marks the hard ones', () => {
    const p = planCaptures(base);
    expect(p.map((c) => c.focalMm)).toEqual([35, 50, 24]);
    expect(p.map((c) => c.harder === null)).toEqual([true, true, false]);
    expect(p.every((c) => c.frames.length === 20)).toBe(true);
    expect(p[0].frames[0].position).not.toEqual(p[1].frames[0].position);
    expect(new Set(p.map((c) => c.name)).size).toBe(3);
  });
  it('parses options and refuses bad ones', () => {
    expect(parseArgs([]).captures).toBe(3);
    expect(parseArgs(['--frames', '60', '--no-render']).render).toBe(false);
    expect(() => parseArgs(['--captures', '1'])).toThrow(/at least 2/);
    expect(() => parseArgs(['--wat'])).toThrow(/unknown/);
  });
});

describe('judgeRun', () => {
  const cap = (name: string, rot: number | null, pos: number | null, joined = true) => ({ name, rendered: 64, registered: joined ? 64 : 0, joined, medianRotationDeg: rot, maxRotationDeg: rot, medianPositionShare: pos, maxPositionShare: pos });
  const run = (captures: ReturnType<typeof cap>[], allJoined = true, failures: string[] = []) => ({ captures, modelsFound: 1, allJoined, alignedCameras: 100, scaleToTruth: 1, failures });
  it('passes numbers shaped like the good run', () => {
    expect(judgeRun(run([cap('a', 0.32, 0.0036), cap('b', 0.31, 0.0054), cap('c', 0.32, 0.0079)]))).toEqual([]);
  });
  it('fails numbers shaped like the first attempt: every capture joined, geometry wrong', () => {
    const p = judgeRun(run([cap('a', 30.9, 0.5855), cap('b', 31.3, 0.3886), cap('c', 113.2, 1.154)]));
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.join(' ')).toMatch(/rotation error 30\.90 deg is over 2/);
  });
  it('fails a missing capture', () => {
    expect(judgeRun(run([cap('a', 0.3, 0.004), cap('b', null, null, false)], false, ['capture "b" did not join the model']))[0]).toMatch(/not every capture joined/);
  });
  it('fails on position alone', () => expect(judgeRun(run([cap('a', 0.3, 0.06), cap('b', 0.3, 0.01)])).join()).toMatch(/position error 6\.0%/));
});
