/**
 * Synthetic captures with known camera poses (F58.9.19.6 / kb:fusion-synthetic-captures): the pure parts.
 * Planning is deterministic from a seed; measurement aligns COLMAP's registered cameras to the true ones with a
 * similarity (Umeyama) fit of camera centres, then reports rotation and position error per capture.
 * No Blender, files or COLMAP here; synthetic-captures.ts does the work.
 */
import { captureOfFrame, judgeJoin, type CaptureAccount } from './scan-multi-lib.js';

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

// ── planning ─────────────────────────────────────────────────────────────────
export interface FramePlan { position: Vec3; lookAt: Vec3 }
export interface CapturePlan {
  name: string; focalMm: number; width: number; height: number; samples: number; harder: string | null;
  light: { elevationDeg: number; azimuthDeg: number; sun: number; ambient: number; color: Vec3 };
  frames: FramePlan[];
}
export interface PlanArgs { seed: number; captures: number; frames: number; width: number; height: number; samples: number; objectSize: number; out: string; mesh?: string; render: boolean }

/** Small deterministic generator (mulberry32): the same seed always gives the same plan. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Capture k orbits the object at its own height, radius, arc and focal length, with its own light. Capture 0 is the
 * baseline (a full turn, 35 mm); capture 1 looks down from higher over most of a turn at 50 mm; capture 2 and later
 * are the HARDER ones: a wider lens, a low raking sun of a different colour, and only part of a turn, so their view of
 * the object overlaps the others on one side only. `harder` says what was made hard, or null.
 */
export function planCaptures(a: Pick<PlanArgs, 'seed' | 'captures' | 'frames' | 'width' | 'height' | 'samples' | 'objectSize'>): CapturePlan[] {
  const r = rng(a.seed);
  const s = a.objectSize;
  const plans: CapturePlan[] = [];
  for (let k = 0; k < a.captures; k++) {
    const hard = k >= 2;
    const radius = s * (k === 0 ? 1.3 : k === 1 ? 1.0 : 1.5) * (0.95 + 0.1 * r());
    const height = s * (k === 0 ? 0.65 : k === 1 ? 1.15 : 0.3) * (0.95 + 0.1 * r());
    const arc = k === 0 ? 360 : k === 1 ? 300 : 200;
    const start = r() * 360;
    const focalMm = k === 0 ? 35 : k === 1 ? 50 : 24;
    const frames: FramePlan[] = [];
    for (let i = 0; i < a.frames; i++) {
      const t = a.frames === 1 ? 0 : i / (a.frames - 1);
      // the full turn must not close on its first frame; a partial arc spans start..start+arc
      const ang = ((start + arc * (k === 0 ? i / a.frames : t)) * Math.PI) / 180;
      const wobble = 1 + 0.04 * Math.sin(t * 6.3 + k) + 0.015 * (r() - 0.5);
      const rr = radius * wobble;
      const hh = height * (1 + 0.08 * Math.sin(t * 4.1 + 2 * k)) + 0.01 * s * (r() - 0.5);
      frames.push({
        position: [rr * Math.cos(ang), rr * Math.sin(ang), hh],
        lookAt: [0.03 * s * (r() - 0.5), 0.03 * s * (r() - 0.5), 0.02 * s * (r() - 0.5)],
      });
    }
    plans.push({
      name: `capture-${String.fromCharCode(97 + k)}`, focalMm, width: a.width, height: a.height, samples: a.samples,
      harder: hard ? 'wider lens (24 mm), low raking sun of a different colour, about 200 degrees of arc at low height' : null,
      light: hard
        ? { elevationDeg: 18, azimuthDeg: 200 + 40 * r(), sun: 2.2, ambient: 0.35, color: [1.0, 0.82, 0.65] }
        : { elevationDeg: 50 + 10 * k, azimuthDeg: 30 + 60 * k + 20 * r(), sun: 3.0, ambient: 0.8, color: [1, 1, 1] },
      frames,
    });
  }
  return plans;
}

const FLAGS = ['seed', 'captures', 'frames', 'width', 'height', 'samples', 'object-size', 'out', 'mesh', 'run-dir', 'steps'];
export function parseArgs(argv: string[]): PlanArgs & { runDir?: string; steps: number } {
  const val: Record<string, string> = {};
  let skipRender = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-render') { skipRender = true; continue; }
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const [flag, inline] = a.slice(2).split(/=(.*)/s);
    if (!FLAGS.includes(flag)) throw new Error(`unknown option ${a}`);
    const v = inline ?? argv[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`--${flag} needs a value`);
    val[flag] = v;
  }
  const int = (k: string, d: number, min: number) => {
    const n = val[k] === undefined ? d : Number(val[k]);
    if (!Number.isInteger(n) || n < min) throw new Error(`--${k} must be an integer of at least ${min}`);
    return n;
  };
  const objectSize = val['object-size'] === undefined ? 2.6 : Number(val['object-size']);
  if (!(objectSize > 0)) throw new Error('--object-size must be positive');
  return {
    seed: int('seed', 7, 0), captures: int('captures', 3, 2), frames: int('frames', 48, 10), width: int('width', 960, 64),
    height: int('height', 540, 64), samples: int('samples', 24, 1), objectSize, out: val.out ?? '', mesh: val.mesh, runDir: val['run-dir'], steps: int('steps', 200, 1),
    render: !skipRender,
  };
}

// ── linear algebra on 3-vectors ──────────────────────────────────────────────
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const mulMV = (m: Mat3, v: Vec3): Vec3 => [m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2], m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2], m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2]];
export const transpose = (m: Mat3): Mat3 => [[m[0][0], m[1][0], m[2][0]], [m[0][1], m[1][1], m[2][1]], [m[0][2], m[1][2], m[2][2]]];
export function mulMM(a: Mat3, b: Mat3): Mat3 {
  const o: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) o[i][j] += a[i][k] * b[k][j];
  return o as Mat3;
}

/** Eigenvectors of a symmetric 4x4 matrix by cyclic Jacobi rotations. Returns {values, vectors} with vectors[i] the i-th eigenvector. */
function jacobi4(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map((r) => [...r]);
  const v = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) off += a[i][j] * a[i][j];
    if (off < 1e-22) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = v[k][p], vkq = v[k][q]; v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: [0, 1, 2, 3].map((i) => a[i][i]), vectors: [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i) => v[i][j])) };
}

function quatToMat([w, x, y, z]: number[]): Mat3 {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ];
}

export interface Similarity { scale: number; R: Mat3; t: Vec3 }
/** x_to = scale * R * x_from + t, least squares over matched points (Umeyama 1991, rotation by Horn's quaternion method, so never a reflection). */
export function umeyama(from: Vec3[], to: Vec3[]): Similarity {
  const n = from.length;
  if (n < 3 || n !== to.length) throw new Error(`similarity fit needs at least 3 matched points (got ${n} and ${to.length})`);
  const mean = (p: Vec3[]): Vec3 => [p.reduce((s, q) => s + q[0], 0) / n, p.reduce((s, q) => s + q[1], 0) / n, p.reduce((s, q) => s + q[2], 0) / n];
  const mf = mean(from), mt = mean(to);
  const A = from.map((p) => sub(p, mf)), B = to.map((p) => sub(p, mt));
  const S: number[][] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; // sum a_i b_i^T
  let varA = 0;
  for (let i = 0; i < n; i++) { varA += A[i][0] ** 2 + A[i][1] ** 2 + A[i][2] ** 2; for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += A[i][r] * B[i][c]; }
  if (varA < 1e-18) throw new Error('similarity fit: the source points are all the same point');
  const N = [
    [S[0][0] + S[1][1] + S[2][2], S[1][2] - S[2][1], S[2][0] - S[0][2], S[0][1] - S[1][0]],
    [S[1][2] - S[2][1], S[0][0] - S[1][1] - S[2][2], S[0][1] + S[1][0], S[2][0] + S[0][2]],
    [S[2][0] - S[0][2], S[0][1] + S[1][0], -S[0][0] + S[1][1] - S[2][2], S[1][2] + S[2][1]],
    [S[0][1] - S[1][0], S[2][0] + S[0][2], S[1][2] + S[2][1], -S[0][0] - S[1][1] + S[2][2]],
  ];
  const { values, vectors } = jacobi4(N);
  const best = values.indexOf(Math.max(...values));
  const R = quatToMat(vectors[best]);
  let num = 0;
  for (let i = 0; i < n; i++) { const ra = mulMV(R, A[i]); num += ra[0] * B[i][0] + ra[1] * B[i][1] + ra[2] * B[i][2]; }
  const scale = num / varA;
  const rm = mulMV(R, mf);
  return { scale, R, t: [mt[0] - scale * rm[0], mt[1] - scale * rm[1], mt[2] - scale * rm[2]] };
}

/** Angle in degrees of the rotation taking a to b: acos((trace(a^T b) - 1) / 2). */
export function rotationErrorDeg(a: Mat3, b: Mat3): number {
  const m = mulMM(transpose(a), b);
  const c = Math.max(-1, Math.min(1, (m[0][0] + m[1][1] + m[2][2] - 1) / 2));
  return (Math.acos(c) * 180) / Math.PI;
}

// ── measurement ──────────────────────────────────────────────────────────────
export interface TrueFrame { file: string; R: Mat3; centre: Vec3 }
export interface TrueCapture { name: string; frames: TrueFrame[] }
export interface TruePoses { objectSize: number; captures: TrueCapture[] }
/** A camera COLMAP registered: R is world-to-camera, centre is the camera centre, both in COLMAP's arbitrary world frame. */
export interface RegisteredCamera { name: string; R: Mat3; centre: Vec3 }

export interface CaptureMeasure {
  name: string; rendered: number; registered: number; joined: boolean;
  medianRotationDeg: number | null; maxRotationDeg: number | null; medianPositionShare: number | null; maxPositionShare: number | null;
}
export interface Measurement { captures: CaptureMeasure[]; modelsFound: number; allJoined: boolean; alignedCameras: number; scaleToTruth: number | null; failures: string[] }

export const median = (v: number[]): number => { const s = [...v].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Registered cameras are named <capture>__<n>.jpg where n is 1-based position in that capture's sorted frames, so frame n is
 * truePoses.captures[capture].frames[n-1]. `models` lists the names registered by every COLMAP sub-model (the first is not
 * assumed largest); `cameras` are those of the largest model, the one used for the alignment.
 */
export function measure(truth: TruePoses, cameras: RegisteredCamera[], models: string[][]): Measurement {
  const supplied: Record<string, number> = {};
  for (const c of truth.captures) supplied[c.name] = c.frames.length;
  const verdict = judgeJoin(supplied, { models });
  const failures = [...verdict.failures];
  const pairs: { cap: string; est: RegisteredCamera; tr: TrueFrame }[] = [];
  for (const cam of cameras) {
    const cap = truth.captures.find((c) => c.name === captureOfFrame(cam.name));
    const n = Number(/__(\d+)\./.exec(cam.name)?.[1]);
    const tr = cap?.frames[n - 1];
    if (cap && tr) pairs.push({ cap: cap.name, est: cam, tr });
  }
  let sim: Similarity | null = null;
  if (pairs.length >= 3) {
    try { sim = umeyama(pairs.map((p) => p.est.centre), pairs.map((p) => p.tr.centre)); } catch (e) { failures.push(`alignment failed: ${(e as Error).message}`); }
  } else failures.push(`only ${pairs.length} registered cameras match a true frame; a similarity alignment needs 3`);
  const out: CaptureMeasure[] = truth.captures.map((c) => {
    const acct: CaptureAccount | undefined = verdict.captures.find((x) => x.name === c.name);
    const mine = sim ? pairs.filter((p) => p.cap === c.name) : [];
    const rot = mine.map((p) => rotationErrorDeg(p.tr.R, mulMM(p.est.R, transpose(sim!.R))));
    const pos = mine.map((p) => { const m = mulMV(sim!.R, p.est.centre); return norm(sub([sim!.scale * m[0] + sim!.t[0], sim!.scale * m[1] + sim!.t[1], sim!.scale * m[2] + sim!.t[2]], p.tr.centre)) / truth.objectSize; });
    return {
      name: c.name, rendered: c.frames.length, registered: acct?.registered ?? 0, joined: acct?.joined ?? false,
      medianRotationDeg: rot.length ? median(rot) : null, maxRotationDeg: rot.length ? Math.max(...rot) : null,
      medianPositionShare: pos.length ? median(pos) : null, maxPositionShare: pos.length ? Math.max(...pos) : null,
    };
  });
  return { captures: out, modelsFound: verdict.modelsFound, allJoined: verdict.singleModel, alignedCameras: pairs.length, scaleToTruth: sim ? sim.scale : null, failures };
}

export function formatMeasurement(m: Measurement): string {
  const f = (x: number | null, d: number, unit = '') => (x === null ? 'n/a' : `${x.toFixed(d)}${unit}`);
  const lines = m.captures.map((c) => `  ${c.name}: registered ${c.registered}/${c.rendered}${c.joined ? '' : '  DID NOT JOIN'}; rotation median ${f(c.medianRotationDeg, 3, ' deg')} max ${f(c.maxRotationDeg, 3, ' deg')}; position median ${f(c.medianPositionShare === null ? null : c.medianPositionShare * 100, 2, '%')} of object size, max ${f(c.maxPositionShare === null ? null : c.maxPositionShare * 100, 2, '%')}`);
  return [...lines, `  COLMAP models: ${m.modelsFound}; ${m.allJoined ? 'every capture joined ONE model' : 'NOT every capture joined one model'}; ${m.alignedCameras} cameras aligned${m.scaleToTruth === null ? '' : `, COLMAP-to-true scale ${m.scaleToTruth.toFixed(4)}`}`, ...m.failures.map((x) => `  FAIL ${x}`)].join('\n');
}
