#!/usr/bin/env npx tsx
/**
 * Measure a room scan's quality and give plain-language tips (F58.9.14 / kb:scan-quality). Script tier: no model.
 *
 *   input   a Stray Scanner folder (rgb.mp4 and odometry.csv: speed, smoothness and angles are measured)
 *           or any video file (blur and exposure only: there is no odometry to measure motion from)
 *   metrics speed (m/s and deg/s), jerk, yaw coverage and path length, blur and exposure from frames
 *           sampled at 2 fps (decoded in memory, nothing is written to disk), and with --receipt the
 *           share of frames a scan:room receipt says COLMAP registered
 *
 * Usage:  npm run scan:quality -- <folder or video> [--receipt receipt.json] [--json] [--fps 2]
 *
 * The thresholds live in QUALITY_THRESHOLDS (scan-quality-lib.ts) and are first guesses.
 * The output contains the person's own capture: keep stdout and --json out of commits and shared logs.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { detectInput, parseOdometry, type OdometryRow } from './scan-room-lib.js';
import {
  blurMetrics, buildTips, exposureMetrics, jerkMetrics, laplacianVariance, meanBrightness, motionSamples,
  QUALITY_THRESHOLDS, registeredShare, speedMetrics, totalPathLength, yawCoverage, type QualityMetrics, type SpeedMetrics,
} from './scan-quality-lib.js';

const SAMPLE_WIDTH = 480;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
}

function probe(video: string): { width: number; height: number; durationS: number } {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:format=duration', '-of', 'json', video], { encoding: 'utf8' }));
  return { width: j.streams[0].width, height: j.streams[0].height, durationS: Number(j.format.duration) };
}

/**
 * Decode the video at `fps`, 480 wide greyscale, and score each frame as it arrives. Frames go through
 * a pipe and are never written to disk.
 */
export function sampleFrames(video: string, fps: number, dims: { width: number; height: number }):
  Promise<{ blur: number[]; brightness: number[] }> {
  const w = SAMPLE_WIDTH;
  const h = 2 * Math.round((dims.height * w) / dims.width / 2);
  const frameBytes = w * h;
  return new Promise((ok, bad) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', video, '-vf', `fps=${fps},scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
    const blur: number[] = [], brightness: number[] = [];
    let pending = Buffer.alloc(0);
    let err = '';
    ff.stdout.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = new Uint8Array(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        blur.push(laplacianVariance(frame, w, h));
        brightness.push(meanBrightness(frame));
      }
    });
    ff.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    ff.on('error', (e) => bad(new Error(`ffmpeg could not start: ${e.message}`)));
    ff.on('close', (code) => (code === 0 ? ok({ blur, brightness }) : bad(new Error(`ffmpeg exited ${code}: ${err.split('\n').slice(-5).join('\n')}`))));
  });
}

export function speedFromOdometry(rows: OdometryRow[]): { linear: SpeedMetrics; angular: SpeedMetrics } {
  const samples = motionSamples(rows);
  const t = QUALITY_THRESHOLDS;
  return {
    linear: speedMetrics(samples, 'linearMps', t.linearMps),
    angular: speedMetrics(samples, 'angularDegPerS', t.angularDegPerS),
  };
}

function report(m: QualityMetrics, tips: string[]): string {
  const lines: string[] = [];
  const num = (x: number | undefined, unit = '') => (x === undefined || Number.isNaN(x) ? 'n/a' : `${x}${unit}`);
  lines.push(`Room scan quality: ${m.source}`);
  if (m.durationS !== null) lines.push(`  duration ${m.durationS.toFixed(1)} s`);
  if (m.speed) {
    lines.push(`Speed`);
    lines.push(`  linear   median ${num(m.speed.linear.median)} m/s   p95 ${num(m.speed.linear.p95)} m/s   peak ${num(m.speed.linear.peak)} m/s   above ${QUALITY_THRESHOLDS.linearMps} m/s for ${num(m.speed.linear.secondsAbove, ' s')}`);
    lines.push(`  angular  median ${num(m.speed.angular.median)}°/s   p95 ${num(m.speed.angular.p95)}°/s   peak ${num(m.speed.angular.peak)}°/s   above ${QUALITY_THRESHOLDS.angularDegPerS}°/s for ${num(m.speed.angular.secondsAbove, ' s')}`);
  }
  if (m.jerk) lines.push(`Smoothness (jerk)  median ${num(m.jerk.median)} m/s³   p95 ${num(m.jerk.p95)} m/s³`);
  if (m.coverage) {
    const c = m.coverage;
    lines.push(`Coverage  ${c.covered} of ${360 / c.binDeg} yaw bins of ${c.binDeg}° have a view; ${c.empty} empty; path ${num(c.pathLengthM, ' m')}`);
  }
  if (m.blur) lines.push(`Blur  median Laplacian variance ${num(m.blur.median)} over ${m.blur.frames} frames; ${Math.round(m.blur.belowShare * 100)}% below ${QUALITY_THRESHOLDS.blurVariance}`);
  if (m.exposure) lines.push(`Exposure  mean brightness ${num(m.exposure.mean)} (0-255); spread (std dev) ${num(m.exposure.spread)}; range ${num(m.exposure.min)} to ${num(m.exposure.max)}`);
  if (m.registeredShare !== undefined) lines.push(`Registered  ${Math.round(m.registeredShare * 100)}% of kept frames placed by COLMAP`);
  lines.push('');
  lines.push(tips.length ? 'Tips' : 'No tips: every measured metric is within its first-guess threshold.');
  for (const t of tips) lines.push(`  - ${t}`);
  return lines.join('\n');
}

export async function scanQuality(argv: string[]): Promise<{ metrics: QualityMetrics; tips: string[] }> {
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(receipt|fps)$/.test(argv[i - 1])));
  const inputArg = positional[0];
  if (!inputArg) throw new Error('usage: npm run scan:quality -- <Stray Scanner folder | video file> [--receipt receipt.json] [--json] [--fps 2]');
  const inputPath = resolve(inputArg);
  if (!existsSync(inputPath)) throw new Error(`no such input: ${inputPath}`);
  const isDir = statSync(inputPath).isDirectory();
  const input = detectInput(inputPath, isDir, isDir ? readdirSync(inputPath) : []);
  const fps = Number(arg(argv, 'fps') ?? 2);
  if (!(fps > 0)) throw new Error('--fps must be a positive number');

  const dims = probe(input.video);
  const metrics: QualityMetrics = { source: basename(inputPath), durationS: Number(dims.durationS.toFixed(1)) };

  if (input.kind === 'stray') {
    const rows = parseOdometry(readFileSync(join(input.dir, 'odometry.csv'), 'utf8'));
    metrics.speed = speedFromOdometry(rows);
    metrics.jerk = jerkMetrics(rows);
    metrics.coverage = { ...yawCoverage(rows), pathLengthM: totalPathLength(rows) };
  }

  const frames = await sampleFrames(input.video, fps, dims);
  metrics.blur = blurMetrics(frames.blur);
  metrics.exposure = exposureMetrics(frames.brightness);

  const receiptPath = arg(argv, 'receipt');
  if (receiptPath) {
    const r = JSON.parse(readFileSync(resolve(receiptPath), 'utf8'));
    metrics.registeredShare = registeredShare(r.frames.registered, r.frames.kept);
  }

  const tips = buildTips(metrics);
  return { metrics, tips };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  scanQuality(argv)
    .then(({ metrics, tips }) => {
      if (argv.includes('--json')) console.log(JSON.stringify({ metrics, tips }, null, 2));
      else console.log(report(metrics, tips));
    })
    .catch((e) => { console.error(`FAILED ${e.message}`); process.exit(1); });
}
