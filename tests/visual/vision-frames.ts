/**
 * Frame sampling for the visual testing suite (F93.1, kb:video-frame-sampling).
 *
 * Why this exists (2026-11-05): the first demo render had grey margins around the app in every
 * frame — a 1280x800 viewport inside a 1920x1080 canvas — and step 1's narration did not match its
 * screens. Both defects were found only because a person extracted a contact sheet by hand with
 * ffmpeg; the suite could neither sample a frame at a named time nor judge margins and blanks.
 * F275.10 (demo QA) will judge narration against these frames and is the next consumer; this module
 * is the shared sampler it stands on. It deliberately adds no mechanism beyond what the suite
 * already runs on: ffmpeg/ffprobe, which the asset pipeline (scripts/content/asset-checks.ts)
 * already requires.
 *
 * Frame read: one ffmpeg call per time — `-ss <sec> -i video -frames:v 1`, scaled, grey, rawvideo
 * to stdout (1 byte per pixel). A seek with `-ss` before `-i` returns the FIRST frame at or after
 * the target; a target in the gap after the last frame's timestamp (the container duration can
 * exceed the last frame by up to one frame interval) comes back empty, so an empty read re-seeks
 * slightly earlier until a frame appears — that is the "clamp to the last frame" contract, and it
 * costs nothing on the happy path.
 *
 * asset-checks' motion measure now runs on this sampler at 64x64. Its numbers on the committed
 * clips must stay identical (recorded 2026-11-05 from the old select=eq(n,0/last) reads:
 * carved-turtle 0.2061, lighthouse-island 0.0543) — tests/visual/vision-frames.test.ts pins that.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type GrayFrame = { atMs: number; width: number; height: number; gray: Uint8Array }; // row-major, 1 byte per pixel

export interface SampleOpts {
  /** Scale width (default 96). */
  width?: number;
  /** Exact height when given (e.g. asset-checks' square 64x64). Omitted: height follows the aspect, even. */
  height?: number;
  /** When given, each frame is ALSO written to <pngDir>/<atMs>.png at full size and full colour. */
  pngDir?: string;
}

/** ffprobe format=duration in milliseconds; throws when the file has no duration. */
export function probeDurationMs(video: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const sec = Number.parseFloat(out.trim());
  if (!Number.isFinite(sec) || !(sec > 0)) throw new Error(`no format=duration in ${video}`);
  return Math.round(sec * 1000);
}

/** The sampling times: 0, everyMs, 2*everyMs, … strictly before durationMs. */
export function cadence(durationMs: number, everyMs: number): number[] {
  if (!Number.isFinite(everyMs) || !(everyMs > 0)) throw new Error('everyMs must be > 0');
  const times: number[] = [];
  for (let t = 0; t < durationMs; t += everyMs) times.push(t);
  return times;
}

function readFrame(video: string, atMs: number, vf: string): { buf: Buffer; usedMs: number } {
  const attempt = (t: number): Buffer | null => {
    try {
      const buf = execFileSync('ffmpeg',
        ['-v', 'error', '-ss', (t / 1000).toFixed(3), '-i', video, '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', '-'],
        { maxBuffer: 1 << 24, stdio: ['ignore', 'pipe', 'pipe'] });
      if (buf.length) return buf;
    } catch {
      // A seek past the last frame exits non-zero; that is the clamp case, not a failure to report yet.
    }
    return null;
  };
  const buf = attempt(atMs);
  if (buf) return { buf, usedMs: atMs };
  // The asked time is in the gap after the last frame's timestamp (or past the end): clamp to the
  // last frame by re-seeking earlier with a DOUBLING step. A seek returns the first frame at or
  // after the target, so once the step is at least the gap between the last frame and the container
  // duration, the first frame found IS the last frame of the video — and every smaller step having
  // failed proves there is no frame between them. The step grows until it covers the duration.
  let durationMs: number;
  try { durationMs = probeDurationMs(video); }
  catch (e) { throw new Error(`no frame near ${atMs} ms in ${video}: ${(e as Error).message.split('\n')[0]}`); }
  for (let step = 100; step <= durationMs; step *= 2) {
    const t = durationMs - step;
    const again = attempt(t);
    if (again) return { buf: again, usedMs: t };
  }
  const first = attempt(0);
  if (first) return { buf: first, usedMs: 0 };
  throw new Error(`no frame near ${atMs} ms in ${video} (duration ${durationMs} ms)`);
}

function writePng(video: string, atMs: number, usedMs: number, pngDir: string): void {
  const file = join(pngDir, `${atMs}.png`);
  const run = (t: number): boolean => {
    try {
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', (t / 1000).toFixed(3), '-i', video, '-frames:v', '1', file],
        { maxBuffer: 1 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch { return false; }
  };
  if (run(usedMs)) return;
  let durationMs: number;
  try { durationMs = probeDurationMs(video); } catch { throw new Error(`could not write ${file}`); }
  for (let step = 100; step <= durationMs; step *= 2) if (run(durationMs - step)) return;
  if (run(0)) return;
  throw new Error(`could not write ${file}`);
}

export function sampleFrames(video: string, atMs: number[], opts: SampleOpts = {}): GrayFrame[] {
  const width = opts.width ?? 96;
  // `scale=w:-2` computes the height from the aspect and forces it even, so no probe is needed to
  // shape the output: grey rawvideo is 1 byte per pixel, so height = bytes / width.
  const vf = opts.height != null ? `scale=${width}:${opts.height},format=gray` : `scale=${width}:-2,format=gray`;
  if (opts.pngDir) mkdirSync(opts.pngDir, { recursive: true });
  const frames: GrayFrame[] = [];
  for (const at of atMs) {
    const { buf, usedMs } = readFrame(video, at, vf);
    const height = opts.height ?? buf.length / width;
    if (!Number.isInteger(height) || buf.length !== width * height) {
      throw new Error(`unexpected rawvideo size ${buf.length} for width ${width} in ${video}`);
    }
    frames.push({ atMs: at, width, height, gray: new Uint8Array(buf) });
    if (opts.pngDir) writePng(video, at, usedMs, opts.pngDir);
  }
  return frames;
}

/** A frame whose grey values vary by less than maxStdDev (default 3) is, to the eye, blank. */
export function isBlank(f: GrayFrame, maxStdDev = 3): boolean {
  const n = f.gray.length;
  if (!n) return false;
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const p = f.gray[i]; s += p; s2 += p * p; }
  const variance = s2 / n - (s / n) * (s / n);
  return Math.sqrt(Math.max(0, variance)) < maxStdDev;
}

function lineUniform(values: number[], edgeMean: number, tolerance: number): boolean {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (Math.abs(mean - edgeMean) > tolerance) return false; // not the same solid band as the edge
  for (const p of values) if (Math.abs(p - mean) > tolerance) return false; // not uniform
  return true;
}

/**
 * Fraction (0..1) of width/height, from each edge, that is a solid band: every column/row uniform
 * within `tolerance` (default 6) of its own mean AND its mean within tolerance of the edge's first
 * column/row mean. Stops at the first non-uniform line.
 */
export function uniformMargins(f: GrayFrame, tolerance = 6): { left: number; right: number; top: number; bottom: number } {
  const { width: w, height: h, gray: g } = f;
  const col = (x: number): number[] => { const v: number[] = []; for (let y = 0; y < h; y++) v.push(g[y * w + x]); return v; };
  const row = (y: number): number[] => { const v: number[] = []; for (let x = 0; x < w; x++) v.push(g[y * w + x]); return v; };
  const run = (lines: number[][], edge: number, tol: number): number => {
    let n = 0;
    while (n < lines.length && lineUniform(lines[n], edge, tol)) n++;
    return n;
  };
  const meanOf = (v: number[]): number => v.reduce((a, b) => a + b, 0) / v.length;
  const left = run(Array.from({ length: w }, (_, x) => col(x)), meanOf(col(0)), tolerance) / w;
  const right = run(Array.from({ length: w }, (_, i) => col(w - 1 - i)), meanOf(col(w - 1)), tolerance) / w;
  const top = run(Array.from({ length: h }, (_, y) => row(y)), meanOf(row(0)), tolerance) / h;
  const bottom = run(Array.from({ length: h }, (_, i) => row(h - 1 - i)), meanOf(row(h - 1)), tolerance) / h;
  return { left, right, top, bottom };
}

/** Any side at least minFraction (default 0.08) is a margin: the content does not fill the frame. */
export function hasMargins(f: GrayFrame, minFraction = 0.08): boolean {
  const m = uniformMargins(f);
  return m.left >= minFraction || m.right >= minFraction || m.top >= minFraction || m.bottom >= minFraction;
}

/** Mean absolute difference, 0..1. Throws on a size mismatch rather than comparing misaligned pixels. */
export function meanAbsDiff(a: GrayFrame, b: GrayFrame): number {
  if (a.width !== b.width || a.height !== b.height || a.gray.length !== b.gray.length) {
    throw new Error(`size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  }
  let s = 0;
  for (let i = 0; i < a.gray.length; i++) s += Math.abs(a.gray[i] - b.gray[i]);
  return s / a.gray.length / 255;
}
