/**
 * Pure parts of the room-scan pipeline (F58.9.6 / kb:room-scan-capture): input detection, Stray Scanner
 * folder validation, odometry.csv parsing, frame selection, the registration check and the receipt shape.
 * No file, ffmpeg or GPU access here, so tests run anywhere; scripts/content/scan-room.ts does the work.
 */
import type { Check } from './asset-checks.js';

export type ScanInput =
  | { kind: 'stray'; dir: string; video: string; files: string[] }
  | { kind: 'video'; video: string };

export const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
/** What a Stray Scanner export must contain for us to treat a folder as one. depth/ is recorded, not required. */
export const STRAY_REQUIRED = ['rgb.mp4', 'odometry.csv', 'camera_matrix.csv'];

/** Which of the required Stray Scanner entries are absent from a directory listing. */
export function strayMissing(listing: string[]): string[] {
  return STRAY_REQUIRED.filter((f) => !listing.includes(f));
}

/**
 * Decide what the argument is. `isDir` and `listing` are supplied by the caller (so this stays pure).
 * A directory that is not a Stray export is refused with the missing names, never guessed at.
 */
export function detectInput(path: string, isDir: boolean, listing: string[] = []): ScanInput {
  if (!isDir) {
    if (!VIDEO_EXT.test(path)) throw new Error(`not a video file or Stray Scanner folder: ${path}`);
    return { kind: 'video', video: path };
  }
  const missing = strayMissing(listing);
  if (missing.length) throw new Error(`not a Stray Scanner export (missing ${missing.join(', ')}): ${path}`);
  return { kind: 'stray', dir: path, video: `${path.replace(/\/$/, '')}/rgb.mp4`, files: listing };
}

export interface OdometryRow {
  timestamp: number; frame: number; position: [number, number, number]; quaternion: [number, number, number, number];
}

/**
 * Stray Scanner odometry.csv: `timestamp, frame, x, y, z, qx, qy, qz, qw`, one row per frame.
 * The pose CONVENTION is not documented by the app, so the first pipeline does not use these poses
 * (COLMAP recomputes them); they are parsed to cross-check the frame count and report the path length.
 */
export function parseOdometry(csv: string): OdometryRow[] {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error('odometry.csv is empty');
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const want = ['timestamp', 'frame', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'];
  const idx = want.map((w) => header.indexOf(w));
  if (idx.some((i) => i < 0)) throw new Error(`odometry.csv header lacks ${want.filter((_, k) => idx[k] < 0).join(', ')}`);
  return lines.slice(1).map((line, n) => {
    const c = line.split(',').map((v) => Number(v.trim()));
    const v = idx.map((i) => c[i]);
    if (v.some((x) => !Number.isFinite(x))) throw new Error(`odometry.csv row ${n + 1} has a non-numeric value`);
    return { timestamp: v[0], frame: v[1], position: [v[2], v[3], v[4]], quaternion: [v[5], v[6], v[7], v[8]] };
  });
}

/** Metres travelled along the odometry path. */
export function pathLength(rows: OdometryRow[]): number {
  let d = 0;
  for (let i = 1; i < rows.length; i++) {
    d += Math.hypot(...rows[i].position.map((p, k) => p - rows[i - 1].position[k]));
  }
  return d;
}

/** Frames per second to extract so the count lands near `target` (default 200; the spec asks 150-300). */
export function chooseFps(durationS: number, nativeFps: number, target = 200): number {
  if (!(durationS > 0)) throw new Error('video has no duration');
  const fps = Math.min(nativeFps || 30, target / durationS);
  return Number(Math.max(fps, 0.2).toFixed(3));
}

/**
 * Keep the sharpest `keep` frames, in original order. `scores` are Laplacian variances (higher is
 * sharper). Returns the indices to keep.
 */
export function selectSharpest(scores: number[], keep: number): number[] {
  if (keep >= scores.length) return scores.map((_, i) => i);
  const cut = [...scores].sort((a, b) => b - a)[keep - 1];
  const out: number[] = [];
  for (let i = 0; i < scores.length && out.length < keep; i++) if (scores[i] >= cut) out.push(i);
  return out;
}

export const MIN_REGISTERED_FRACTION = 0.5;

/** COLMAP must place at least half of the frames; otherwise the poses are not trustworthy enough to train on. */
export function judgeRegistration(registered: number, total: number, minFraction = MIN_REGISTERED_FRACTION): Check {
  const problems: string[] = [];
  const fraction = total > 0 ? registered / total : 0;
  if (!(total > 0)) problems.push('no frames were extracted');
  else if (fraction < minFraction) {
    problems.push(`COLMAP registered ${registered} of ${total} frames (${(fraction * 100).toFixed(0)}%), need at least ${(minFraction * 100).toFixed(0)}%`);
  }
  return { pass: problems.length === 0, problems, notes: [], measured: { registered, total, fraction: Number(fraction.toFixed(3)) } };
}

export interface ScanReceipt {
  origin: 'reconstructed';
  input: { kind: ScanInput['kind']; name: string; sha256: string; bytes: number };
  frames: { extracted: number; kept: number; registered: number; fps: number };
  tools: Record<string, string>;
  settings: Record<string, string | number>;
  stagesS: Record<string, number>;
  gaussians: number;
  output: { file: string; sha256: string; bytes: number };
  checks: { registration: Check; splat: Check };
  /** F58.9.11: Gaussians outside the robust box of their own centres (floaters) were dropped from `output`. */
  crop?: {
    box: { min: number[]; max: number[] }; before: number; after: number; removed: number;
    rawExtent: number; extent: number; uncropped: { file: string; sha256: string; bytes: number };
  };
  /** F58.9.11: the cropped PLY was thinned to ship: SH bands dropped and/or adaptive decimation. Lossy. */
  reduce?: { before: number; after: number; shDegree: number | null; maxGaussians: number | null };
  /** F58.9.11: a LOSSY compressed copy of output, converted back and checked. Absent on receipts made before it. */
  compressed?: {
    format: 'spz' | 'sog'; lossy: true; file: string; sha256: string; bytes: number; ratio: number; gaussians: number; extent: number;
    check: { pass: boolean; problems: string[] };
  };
  ranAt: string;
  notes: string[];
}

const SHA = /^[0-9a-f]{64}$/;
/** The receipt is what labels the splat "reconstructed"; report every way one fails to. */
export function validateReceipt(r: ScanReceipt): string[] {
  const p: string[] = [];
  if (r.origin !== 'reconstructed') p.push(`origin is ${r.origin}, must be reconstructed`);
  if (!SHA.test(r.input?.sha256 ?? '')) p.push('input sha256 missing or malformed');
  if (!SHA.test(r.output?.sha256 ?? '')) p.push('output sha256 missing or malformed');
  if (!(r.gaussians > 0)) p.push('no Gaussians recorded');
  if (!(r.frames?.registered >= 0) || r.frames.registered > r.frames.kept) p.push('registered count is inconsistent with kept frames');
  for (const k of ['ffmpeg', 'pycolmap', 'brush']) if (!r.tools?.[k]) p.push(`tool version missing: ${k}`);
  for (const k of ['frames', 'poses', 'train']) if (!(r.stagesS?.[k] >= 0)) p.push(`stage duration missing: ${k}`);
  if (!r.checks?.registration?.pass) p.push('registration check did not pass');
  if (!r.checks?.splat?.pass) p.push('splat check did not pass');
  if (r.crop) {
    const c = r.crop;
    if (c.before !== c.after + c.removed) p.push(`crop counts do not add up: ${c.before} before, ${c.after} after, ${c.removed} removed`);
    const expected = r.reduce ? r.reduce.before : r.gaussians;
    if (c.after !== expected) p.push(`crop kept ${c.after} Gaussians, ${r.reduce ? 'reduce started from' : 'output has'} ${expected}`);
    if (!(c.extent <= c.rawExtent)) p.push('cropped extent is larger than the raw extent');
    if (!SHA.test(c.uncropped?.sha256 ?? '')) p.push('uncropped sha256 missing or malformed');
  }
  if (r.reduce && r.reduce.after !== r.gaussians) p.push(`reduce left ${r.reduce.after} Gaussians, output has ${r.gaussians}`);
  if (r.compressed) {
    const c = r.compressed;
    if (!SHA.test(c.sha256 ?? '')) p.push('compressed sha256 missing or malformed');
    if (c.lossy !== true) p.push('compressed copy is not recorded as lossy');
    if (!(c.ratio > 1)) p.push(`compressed ratio ${c.ratio} is not a reduction`);
    if (c.gaussians !== r.gaussians) p.push(`compressed copy has ${c.gaussians} Gaussians, output has ${r.gaussians}`);
    if (!c.check?.pass) p.push('compressed decode check did not pass');
  }
  return p;
}
