#!/usr/bin/env npx tsx
/**
 * Reconstruct a scanned room into a Gaussian splat on the person's own machine (F58.9.6 / kb:room-scan-capture).
 *
 *   input   a Stray Scanner export folder (rgb.mp4, odometry.csv, camera_matrix.csv, depth/) or any video file
 *   stages  frames  ffmpeg extracts ~200 frames, the blurriest dropped (Laplacian variance)
 *           poses   COLMAP (pycolmap) sequential matching + incremental mapping
 *           train   Brush (Apache-2.0) trains a splat from the COLMAP folder
 *           check   COLMAP registered >= 50% of the frames AND asset-checks.ts accepts the PLY
 *           crop    drop floaters outside the robust (1st-99th percentile + margin) box of the Gaussian centres
 *           compress a LOSSY copy (splat.sog by default, or --format spz) converted back and count/extent-checked
 *   output  <out>/splat.ply, <out>/splat.<sog|spz> and <out>/receipt.json (origin "reconstructed")
 *
 * A RECONSTRUCTED SPLAT RECORDS WHAT WAS THERE; the receipt is what says so. The tools' exit codes are
 * not evidence: a stage that exits 0 but registers 3 frames, or writes a PLY of NaNs, fails here.
 *
 * Stray Scanner's ARKit poses and depth are NOT used in this version: the app does not document the axis
 * or quaternion convention, so COLMAP recomputes poses from the video. odometry.csv is parsed only to
 * cross-check the frame count and report the path length.
 *
 * Usage:   npm run scan:room -- <input> [--out dir] [--steps 30000] [--frames 200]
 *          npm run scan:room -- --check <out dir>      verify a finished scan's receipt, hash and splat
 * Tools:   scripts/content/gen-setup.sh installs them into RECKONS_GEN_HOME (~/.local/share/reckons/gen).
 * Output stays out of git: the default out dir is ~/.local/share/reckons/scans/<input-hash>.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { checkSplat } from './asset-checks.js';
import { compressSplat, cropPly, verifyCompressed, type CompressFormat } from './splat-compress.js';
import { plyCentres } from '../../src/lib/3d/splat-check.js';
import { robustExtent } from '../../src/lib/3d/robust-extent.js';
import {
  chooseFps, detectInput, judgeRegistration, parseOdometry, pathLength, selectSharpest, validateReceipt,
  type ScanReceipt,
} from './scan-room-lib.js';

const GEN = process.env.RECKONS_GEN_HOME ?? join(homedir(), '.local/share/reckons/gen');
const PY = join(GEN, 'venv/bin/python');
const BRUSH = join(GEN, 'bin/brush/brush_app');
const VK_LIB = join(GEN, 'lib/vk/usr/lib/x86_64-linux-gnu');
const COLMAP_PY = resolve(import.meta.dirname, 'scan_colmap.py');

class StageError extends Error {
  constructor(public stage: string, msg: string) { super(`[${stage}] ${msg}`); }
}

function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  return new Promise((ok, bad) => createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok(h.digest('hex'))).on('error', bad));
}

function arg(argv: string[], name: string, fallback?: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  return argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
}

/** Variance of a Laplacian-filtered 480-wide greyscale copy: a standard cheap blur score. */
async function sharpness(file: string): Promise<number> {
  const { data } = await sharp(file).resize(480).greyscale()
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 })
    .raw().toBuffer({ resolveWithObject: true });
  let sum = 0, sumSq = 0;
  for (const v of data) { sum += v; sumSq += v * v; }
  const mean = sum / data.length;
  return sumSq / data.length - mean * mean;
}

function probe(video: string) {
  const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height,avg_frame_rate,nb_frames:format=duration', '-of', 'json', video], { encoding: 'utf8' }));
  const [n, d] = String(j.streams[0].avg_frame_rate).split('/').map(Number);
  return { width: j.streams[0].width as number, height: j.streams[0].height as number, fps: d ? n / d : n, durationS: Number(j.format.duration) };
}

function run(stage: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', maxBuffer: 256 << 20 });
  if (r.error) throw new StageError(stage, `${cmd} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new StageError(stage, `${basename(cmd)} exited ${r.status}\n${(r.stderr || r.stdout).split('\n').slice(-15).join('\n')}`);
  return r.stdout + r.stderr;
}

export async function scanRoom(argv: string[]): Promise<ScanReceipt> {
  const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && /^--(out|steps|frames|format)$/.test(argv[i - 1])));
  const inputArg = positional[0];
  if (!inputArg) throw new Error('usage: npm run scan:room -- <Stray Scanner folder | video file> [--out dir] [--steps N] [--frames N]');
  const inputPath = resolve(inputArg);
  if (!existsSync(inputPath)) throw new Error(`no such input: ${inputPath}`);
  const isDir = statSync(inputPath).isDirectory();
  const input = detectInput(inputPath, isDir, isDir ? readdirSync(inputPath) : []);
  for (const [what, p] of [['COLMAP (pycolmap venv)', PY], ['Brush', BRUSH]] as const) {
    if (!existsSync(p)) throw new Error(`${what} not installed at ${p} — run scripts/content/gen-setup.sh`);
  }
  const steps = Number(arg(argv, 'steps', '30000'));
  const target = Number(arg(argv, 'frames', '200'));

  const inputHash = await sha256File(input.video);
  const out = resolve(arg(argv, 'out') ?? join(homedir(), '.local/share/reckons/scans', inputHash.slice(0, 12)));
  mkdirSync(out, { recursive: true });
  const work = join(out, 'work');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'cand'), { recursive: true });
  mkdirSync(join(work, 'images'), { recursive: true });
  const notes: string[] = [];
  const stagesS: Record<string, number> = {};
  const timed = async <T>(name: string, f: () => Promise<T> | T) => {
    const t = Date.now();
    try { return await f(); } finally { stagesS[name] = Number(((Date.now() - t) / 1000).toFixed(1)); console.log(`   ${name}: ${stagesS[name]}s`); }
  };

  // The phone's own pose log, when there is one: cross-check only.
  const info = probe(input.video);
  if (input.kind === 'stray') {
    const rows = parseOdometry(readFileSync(join(input.dir, 'odometry.csv'), 'utf8'));
    const approxFrames = Math.round(info.durationS * info.fps);
    notes.push(`odometry.csv: ${rows.length} poses, ${pathLength(rows).toFixed(2)} m travelled (video about ${approxFrames} frames); phone poses and depth not used`);
    if (Math.abs(rows.length - approxFrames) > Math.max(5, approxFrames * 0.05)) notes.push('odometry row count differs from the video frame count by more than 5%');
  }

  // ── frames
  console.log(`== frames (${info.width}x${info.height}, ${info.durationS.toFixed(1)} s, ${info.fps.toFixed(1)} fps)`);
  let extracted = 0, kept = 0;
  const fps = chooseFps(info.durationS, info.fps, Math.round(target * 1.25));
  await timed('frames', async () => {
    run('frames', 'ffmpeg', ['-v', 'error', '-y', '-i', input.video, '-vf', `fps=${fps},scale='min(1600,iw)':'min(1600,ih)':force_original_aspect_ratio=decrease`, '-q:v', '2', join(work, 'cand', '%05d.jpg')]);
    const cands = readdirSync(join(work, 'cand')).filter((f) => f.endsWith('.jpg')).sort();
    extracted = cands.length;
    if (extracted < 20) throw new StageError('frames', `only ${extracted} frames extracted; need a video with at least a few seconds of motion`);
    const scores: number[] = [];
    for (const f of cands) scores.push(await sharpness(join(work, 'cand', f)));
    const keepIdx = selectSharpest(scores, Math.min(extracted, target));
    for (const i of keepIdx) copyFileSync(join(work, 'cand', cands[i]), join(work, 'images', cands[i]));
    kept = keepIdx.length;
  });
  console.log(`   ${extracted} extracted at ${fps} fps, ${kept} kept after dropping the blurriest`);

  // ── poses
  console.log('== poses (COLMAP, sequential matching)');
  let registered = 0, pycolmap = 'unknown';
  await timed('poses', () => {
    const o = run('poses', PY, [COLMAP_PY, work]);
    const line = o.trim().split('\n').reverse().find((l) => l.startsWith('{'));
    if (!line) throw new StageError('poses', `no result from COLMAP\n${o.slice(-600)}`);
    const j = JSON.parse(line);
    registered = j.registered; pycolmap = j.version ?? 'unknown';
    notes.push(`colmap: ${j.models} model(s), ${j.points} sparse points, features ${j.featuresS}s, matching ${j.matchingS}s, mapping ${j.mappingS}s`);
  });
  const registration = judgeRegistration(registered, kept);
  console.log(`   registered ${registered} of ${kept}`);
  if (!registration.pass) throw new StageError('poses', registration.problems.join('; '));

  // ── train
  console.log(`== train (Brush, ${steps} steps)`);
  const ply = join(out, 'splat.ply');
  rmSync(ply, { force: true });
  await timed('train', () => {
    run('train', BRUSH, [work, '--total-steps', String(steps), '--export-every', String(steps), '--export-path', out, '--export-name', 'splat.ply',
      '--eval-every', String(steps * 10), '--seed', '42'],
      { ...process.env, LD_LIBRARY_PATH: `${VK_LIB}:${process.env.LD_LIBRARY_PATH ?? ''}` });
  });
  if (!existsSync(ply)) throw new StageError('train', `Brush exited 0 but wrote no ${ply} (it wrote: ${readdirSync(out).join(', ')})`);

  // ── crop: drop floaters far outside the room, so they neither inflate the extent nor the compressed file
  console.log('== crop');
  const uncropped = join(out, 'splat.uncropped.ply');
  let crop: ScanReceipt['crop'];
  await timed('crop', async () => {
    const raw = checkSplat(ply);
    if (!raw.pass) throw new StageError('crop', `trained splat failed its check: ${raw.problems.join('; ')}`);
    const re = robustExtent(await plyCentres(new Uint8Array(readFileSync(ply)), 500_000));
    if (!re) throw new StageError('crop', 'no usable Gaussian centres');
    rmSync(uncropped, { force: true });
    renameSync(ply, uncropped);
    cropPly(uncropped, ply, re.box);
    const after = checkSplat(ply);
    if (!after.pass) throw new StageError('crop', `cropped splat failed its check: ${after.problems.join('; ')}`);
    const before = Number(raw.measured.count), kept = Number(after.measured.count);
    crop = {
      box: { min: re.box.min.map((v) => Number(v.toFixed(4))), max: re.box.max.map((v) => Number(v.toFixed(4))) },
      before, after: kept, removed: before - kept, rawExtent: Number(raw.measured.rawExtent), extent: Number(after.measured.rawExtent),
      uncropped: { file: 'splat.uncropped.ply', sha256: await sha256File(uncropped), bytes: statSync(uncropped).size },
    };
    console.log(`   ${before} -> ${kept} Gaussians (${before - kept} floaters dropped), extent ${crop.rawExtent} -> ${crop.extent}`);
  });

  // ── check
  console.log('== check');
  const splat = checkSplat(ply);
  if (!splat.pass) throw new StageError('check', `splat check failed: ${splat.problems.join('; ')}`);

  // ── compress (lossy; the PLY stays the record, the compressed copy is what a browser should load)
  console.log('== compress');
  let compressed: ScanReceipt['compressed'];
  await timed('compress', () => {
    const c = compressSplat(ply, { format: (arg(argv, 'format') as CompressFormat | undefined) });
    if (!c.check.pass) throw new StageError('compress', `compressed copy failed its decode check: ${c.check.problems.join('; ')}`);
    compressed = { format: c.format, lossy: true, file: c.file, sha256: c.sha256, bytes: c.bytes, ratio: c.ratio, gaussians: c.gaussians, extent: c.extent, check: { pass: c.check.pass, problems: c.check.problems } };
    console.log(`   ${c.file}: ${(c.bytes / 1e6).toFixed(2)} MB, ${c.ratio}x smaller than the PLY (lossy)`);
  });

  const receipt: ScanReceipt = {
    origin: 'reconstructed',
    input: { kind: input.kind, name: basename(inputPath), sha256: inputHash, bytes: statSync(input.video).size },
    frames: { extracted, kept, registered, fps },
    tools: {
      ffmpeg: run('frames', 'ffmpeg', ['-version']).split('\n')[0],
      pycolmap,
      brush: run('train', BRUSH, ['--version']).trim(),
    },
    settings: { totalSteps: steps, targetFrames: target, matching: 'sequential overlap 10', cameraModel: 'SIMPLE_RADIAL single camera', minRegisteredFraction: 0.5, seed: 42 },
    stagesS,
    gaussians: Number(splat.measured.count),
    output: { file: 'splat.ply', sha256: await sha256File(ply), bytes: statSync(ply).size },
    checks: { registration, splat },
    crop,
    compressed,
    ranAt: new Date().toISOString(),
    notes,
  };
  const bad = validateReceipt(receipt);
  if (bad.length) throw new StageError('check', `receipt invalid: ${bad.join('; ')}`);
  writeFileSync(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  rmSync(join(work, 'cand'), { recursive: true, force: true });
  console.log(`== done: ${ply} (${receipt.gaussians} Gaussians, ${(receipt.output.bytes / 1e6).toFixed(1)} MB)\n   receipt: ${join(out, 'receipt.json')}`);
  return receipt;
}

/** `--check <out dir>`: re-verify a finished scan from its receipt alone (the F166 done-when). */
export async function checkScan(dir: string): Promise<string[]> {
  const rf = join(resolve(dir), 'receipt.json');
  if (!existsSync(rf)) return [`no receipt.json in ${dir}`];
  const r = JSON.parse(readFileSync(rf, 'utf8')) as ScanReceipt;
  const problems = validateReceipt(r);
  const ply = join(resolve(dir), r.output?.file ?? 'splat.ply');
  if (!existsSync(ply)) return [...problems, `missing ${ply}`];
  if (await sha256File(ply) !== r.output.sha256) problems.push('splat.ply does not match the receipt hash');
  const c = checkSplat(ply);
  if (!c.pass) problems.push(...c.problems);
  if (r.compressed) problems.push(...verifyCompressed(resolve(dir), r.compressed));
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2);
  const run = a[0] === '--check'
    ? checkScan(a[1] ?? '.').then((p) => { if (p.length) throw new Error(p.join('\n')); console.log('scan receipt and splat verified'); })
    : scanRoom(a);
  run.catch((e) => { console.error(`\nFAILED ${e.message}`); process.exit(1); });
}
