/**
 * Acceptance checks for generated assets (F58.9.1 / kb:splat-local-pipeline).
 *
 * THE TOOL'S EXIT CODE IS NOT EVIDENCE. A diffusion model will happily write a grey square, a video
 * model a clip in which nothing moves, and a decoder a PLY whose Gaussians are all NaN — each with
 * exit 0. So every stage of scripts/content/gen-assets.ts is accepted by one of these checks, which
 * know nothing about the tool that produced the file (the F166 done-when rule, and the same idea
 * as checkImage/checkGlb in blender-render.ts).
 *
 * The judging functions are pure and unit-tested; the readers around them do the file and ffmpeg
 * work so the tests need neither a GPU nor ffmpeg.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

export interface Check {
  pass: boolean;
  /** Why it failed, or empty. */
  problems: string[];
  /** Things worth saying that do not fail the check (e.g. low motion). */
  notes: string[];
  /** Measured values, recorded in the receipt. */
  measured: Record<string, number | string>;
}

// ── Image ────────────────────────────────────────────────────────────────────

export interface ImageStats { width: number; height: number; channelStdev: number[] }

/** A real picture has size and variation; a flat or tiny one is a failed generation. */
export function judgeImage(s: ImageStats, expect?: { width?: number; height?: number }): Check {
  const problems: string[] = [];
  if (s.width < 64 || s.height < 64) problems.push(`too small: ${s.width}x${s.height}`);
  if (expect?.width && s.width !== expect.width) problems.push(`width ${s.width}, expected ${expect.width}`);
  if (expect?.height && s.height !== expect.height) problems.push(`height ${s.height}, expected ${expect.height}`);
  const spread = Math.max(...s.channelStdev.slice(0, 3));
  if (!(spread >= 4)) problems.push(`flat image: largest channel standard deviation ${spread.toFixed(2)}`);
  return {
    pass: problems.length === 0, problems, notes: [],
    measured: { width: s.width, height: s.height, maxChannelStdev: Number(spread.toFixed(2)) },
  };
}

export async function checkImage(file: string, expect?: { width?: number; height?: number }): Promise<Check> {
  try {
    const img = sharp(file);
    const meta = await img.metadata();
    const stats = await img.stats();
    return judgeImage({ width: meta.width ?? 0, height: meta.height ?? 0, channelStdev: stats.channels.map((c) => c.stdev) }, expect);
  } catch (e) {
    return { pass: false, problems: [`not a decodable image: ${(e as Error).message}`], notes: [], measured: {} };
  }
}

// ── Video ────────────────────────────────────────────────────────────────────

export interface VideoStats {
  width: number; height: number; frames: number; durationS: number;
  /** Mean absolute difference between the first and last frame, 0..1 (64x64 greyscale). */
  motion: number;
}

/** Below this the clip is, to the eye, a still image. Measured on the first run (2026-10-14). */
export const LOW_MOTION = 0.01;

export function judgeVideo(s: VideoStats, expect?: { frames?: number }): Check {
  const problems: string[] = [];
  const notes: string[] = [];
  if (s.width < 64 || s.height < 64) problems.push(`too small: ${s.width}x${s.height}`);
  if (s.frames < 2) problems.push(`only ${s.frames} frame(s)`);
  if (expect?.frames && s.frames !== expect.frames) problems.push(`${s.frames} frames, expected ${expect.frames}`);
  if (!(s.durationS > 0)) problems.push('no duration');
  // Motion is reported, not failed: a slow clip is a weak result, not a broken file. The receipt and
  // the documentation say so, which is the honest outcome when the model ignored the prompt.
  if (s.motion < LOW_MOTION) notes.push(`low motion: first and last frames differ by ${(s.motion * 100).toFixed(2)}%`);
  return {
    pass: problems.length === 0, problems, notes,
    measured: { width: s.width, height: s.height, frames: s.frames, durationS: s.durationS, motion: Number(s.motion.toFixed(4)) },
  };
}

function grayFrame(file: string, select: string): Buffer {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `${select},scale=64:64,format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
}

export function checkVideo(file: string, expect?: { frames?: number }): Check {
  try {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_read_frames:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
    const st = probe.streams?.[0] ?? {};
    const frames = Number(st.nb_read_frames ?? 0);
    const first = grayFrame(file, 'select=eq(n\\,0)');
    const last = grayFrame(file, `select=eq(n\\,${Math.max(0, frames - 1)})`);
    let sum = 0;
    for (let i = 0; i < Math.min(first.length, last.length); i++) sum += Math.abs(first[i] - last[i]);
    const motion = first.length ? sum / first.length / 255 : 0;
    return judgeVideo({ width: Number(st.width ?? 0), height: Number(st.height ?? 0), frames, durationS: Number(probe.format?.duration ?? 0), motion }, expect);
  } catch (e) {
    return { pass: false, problems: [`not a decodable video: ${(e as Error).message.split('\n')[0]}`], notes: [], measured: {} };
  }
}

// ── Gaussian splat (PLY) ─────────────────────────────────────────────────────
// The parse lives in src/lib/3d/splat-check.ts so the browser's Import a scan runs the SAME checks.
import { judgeSplatPly } from '../../src/lib/3d/splat-check';
export { judgeSplatPly, REQUIRED_SPLAT_PROPS } from '../../src/lib/3d/splat-check';

export function checkSplat(file: string, expect?: { count?: number }): Check {
  try { return judgeSplatPly(new Uint8Array(readFileSync(file)), expect); }
  catch (e) { return { pass: false, problems: [`unreadable: ${(e as Error).message}`], notes: [], measured: {} }; }
}

/** Dispatch on extension. */
export async function checkAsset(file: string): Promise<Check> {
  if (/\.(png|webp|jpe?g)$/i.test(file)) return checkImage(file);
  if (/\.(webm|mp4)$/i.test(file)) return checkVideo(file);
  if (/\.ply$/i.test(file)) return checkSplat(file);
  return { pass: false, problems: [`no check for ${file}`], notes: [], measured: {} };
}
