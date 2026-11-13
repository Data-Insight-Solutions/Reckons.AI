#!/usr/bin/env npx tsx
/** Synthetic room benchmark, script tier (kb:synthetic-room-benchmark).
 *
 * npm run bench:room -- --prepare /outside/repo/dataset [--frames 300 --width 1600 --samples 40]
 * npm run bench:room -- --dataset /outside/repo/dataset --out /outside/repo/run [--steps 30000 --max-splats 280000 --sh-degree 3]
 * Add --baseline /outside/repo/other-run/result.json to compare identical view sets.
 *
 * Blender renders exact camera poses and disjoint train/test views. Brush evaluates those held-out
 * views; we independently score every saved image. Fidelity applies to the trained PLY BEFORE SPZ
 * compression; the SPZ gets structural verification only. This is not a scan/COLMAP benchmark.
 * Heavy GPU work is opt-in, bounded by the caller (e.g. systemd-run --user --scope -p MemoryMax=12G).
 * Never updates the shipped room. Local result.json + review.html retain the evidence for review.
 */
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkSplat } from './asset-checks.js';
import { compressSplat } from './splat-compress.js';
import { assertComparable, METRIC_VERSION, readDataset, scoreViews } from './room-bench-lib.js';

const GEN = process.env.RECKONS_GEN_HOME ?? join(homedir(), '.local/share/reckons/gen');
const ROOT = resolve(import.meta.dirname, '../..');
const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

export function positiveInt(value: string, name: string, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
  return n;
}

function freshDirectory(dir: string): void {
  const rel = relative(ROOT, dir);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..')) throw new Error('Benchmark output must stay outside the checkout');
  if (existsSync(dir)) throw new Error(`Refusing to overwrite ${dir}; use a fresh directory`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

async function run(command: string, args: string[], log: string, env = process.env): Promise<void> {
  const fd = openSync(log, 'w', 0o600);
  try {
    await new Promise<void>((ok, bad) => {
      const child = spawn(command, args, { env, stdio: ['ignore', fd, fd] });
      child.on('error', bad);
      child.on('exit', (code, signal) => code === 0 ? ok() : bad(new Error(`${command} failed (${signal ?? code}); see ${log}`)));
    });
  } finally { closeSync(fd); }
}

export async function main(argv: string[]): Promise<void> {
  const { values: v } = parseArgs({ args: argv, options: {
    prepare: { type: 'string' }, dataset: { type: 'string' }, out: { type: 'string' }, baseline: { type: 'string' },
    frames: { type: 'string', default: '300' }, width: { type: 'string', default: '1600' }, samples: { type: 'string', default: '40' },
    steps: { type: 'string', default: '30000' }, 'max-splats': { type: 'string', default: '280000' },
    'sh-degree': { type: 'string', default: '3' }, seed: { type: 'string', default: '7' }, help: { type: 'boolean' },
  } });
  if (v.help) {
    console.log('bench:room --prepare DIR [--frames 300 --width 1600 --samples 40 --seed 7]\nbench:room --dataset DIR --out DIR [--steps 30000 --max-splats 280000 --sh-degree 3 --seed 7 --baseline result.json]\nOutput directories must be new and outside the checkout. Set CYCLES_DEVICE for Blender. Brush uses its available GPU.');
    return;
  }
  const seed = positiveInt(v.seed!, 'seed', 0, 2147483647);
  if (v.prepare) {
    if (v.dataset || v.out || v.baseline) throw new Error('--prepare cannot be combined with a training run');
    const frames = positiveInt(v.frames!, 'frames', 32, 3000), width = positiveInt(v.width!, 'width', 64, 1600);
    const samples = positiveInt(v.samples!, 'samples', 1, 512);
    const dir = resolve(v.prepare);
    freshDirectory(dir);
    console.log(`Rendering ${frames} synthetic views; log: ${join(dir, 'render.log')}`);
    await run('blender', ['-b', '-t', '6', '-P', join(ROOT, 'scripts/content/scan-synthetic-room.py'), '--', dir, String(frames), String(seed), String(samples), String(width)],
      join(dir, 'render.log'), { ...process.env, ROOM_BENCHMARK: '1', FRAME_ONLY: '' });
    const dataset = await readDataset(dir);
    console.log(`Dataset ${dataset.sha256}: ${dataset.train.frames.length} training / ${dataset.test.frames.length} held-out views`);
    return;
  }
  if (!v.dataset || !v.out) throw new Error('Use --prepare DIR, or --dataset DIR --out DIR (see --help)');
  const steps = positiveInt(v.steps!, 'steps', 1, 100000), maxSplats = positiveInt(v['max-splats']!, 'max-splats', 1000, 2000000);
  const shDegree = positiveInt(v['sh-degree']!, 'sh-degree', 0, 3);
  const datasetDir = resolve(v.dataset), out = resolve(v.out);
  const dataset = await readDataset(datasetDir);
  const baseline = v.baseline ? JSON.parse(readFileSync(resolve(v.baseline), 'utf8')) : null;
  if (baseline) {
    if (baseline.status !== 'measured' || baseline.evaluationStage !== 'trained-ply-before-compression') throw new Error('Baseline is not a complete compatible measurement');
    assertComparable({ datasetSha256: dataset.sha256, metric: METRIC_VERSION }, baseline);
  }
  const brush = join(GEN, 'bin/brush/brush_app');
  const brushVersion = execFileSync(brush, ['--version'], { encoding: 'utf8' }).trim();
  freshDirectory(out);
  const started = Date.now();
  try {
    const args = [datasetDir, '--total-steps', String(steps), '--max-splats', String(maxSplats), '--sh-degree', String(shDegree),
      '--seed', String(seed), '--eval-every', String(steps), '--eval-save-to-disk', '--export-every', String(steps),
      '--export-path', out, '--export-name', 'splat.ply'];
    writeFileSync(join(out, 'run.json'), JSON.stringify({ datasetSha256: dataset.sha256, brushVersion, args, startedAt: new Date(started).toISOString() }, null, 2));
    console.log(`Training ${steps} steps, cap ${maxSplats}, SH ${shDegree}; log: ${join(out, 'train.log')}`);
    await run(brush, args, join(out, 'train.log'), { ...process.env, LD_LIBRARY_PATH: `${join(GEN, 'lib/vk/usr/lib/x86_64-linux-gnu')}:${process.env.LD_LIBRARY_PATH ?? ''}` });
    const trainSeconds = (Date.now() - started) / 1000;
    const check = checkSplat(join(out, 'splat.ply'));
    if (!check.pass) throw new Error(`Trained splat failed checks: ${check.problems.join('; ')}`);
    const scores = await scoreViews(dataset, datasetDir, join(out, `eval_${steps}`));
    if ((await readDataset(datasetDir)).sha256 !== dataset.sha256) throw new Error('Dataset changed during the run; refusing a mixed measurement');
    const compressed = compressSplat(join(out, 'splat.ply'), { format: 'spz' });
    if (!compressed.check.pass) throw new Error(`SPZ verification failed: ${compressed.check.problems.join('; ')}`);
    const result = {
      status: 'measured', at: new Date().toISOString(), datasetSha256: dataset.sha256, manifest: dataset.manifest,
      evaluationStage: 'trained-ply-before-compression', brushVersion, brushSha256: hash(brush),
      settings: { steps, maxSplats, shDegree, seed }, trainViews: dataset.train.frames.length, ...scores,
      trainSeconds, totalSeconds: (Date.now() - started) / 1000,
      ply: { sha256: hash(join(out, 'splat.ply')), ...check.measured }, compressed,
      comparison: baseline ? {
        baselineAt: baseline.at,
        psnrDeltaDb: scores.aggregate.psnrDb === null || baseline.aggregate.psnrDb === null ? null : scores.aggregate.psnrDb - baseline.aggregate.psnrDb,
        ssimDelta: scores.aggregate.ssim - baseline.aggregate.ssim,
        bytesDelta: compressed.bytes - baseline.compressed.bytes,
        trainSecondsDelta: trainSeconds - baseline.trainSeconds,
      } : null,
      limitations: ['Fidelity evaluates the trained PLY, not the compressed SPZ or the browser renderer.',
        'Known Blender poses bypass COLMAP. These measurements do not predict real phone scan quality.',
        'No automatic quality approval or replacement of the shipped room. Inspect every view in review.html.',
        'PSNR null means identical pixels (infinite PSNR); SSIM is block8 luminance, not a library default.'],
    };
    mkdirSync(join(out, 'reference'));
    for (const view of scores.views) copyFileSync(join(datasetDir, view.file), join(out, 'reference', view.file));
    const html = `<!doctype html><meta charset="utf-8"><title>Synthetic room benchmark</title>
<style>body{font:16px system-ui;background:#181b20;color:#eee;max-width:1500px;margin:2rem auto}article{margin:2rem 0}img{width:49%;height:auto}p{line-height:1.5}</style>
<h1>Synthetic room: held-out views</h1><p>Reference left, trained PLY right. SPZ appearance is not scored. ${steps} steps; SH ${shDegree}; cap ${maxSplats}.</p>
<p>PSNR ${scores.aggregate.psnrDb?.toFixed(3) ?? 'infinite'} dB; block8 SSIM ${scores.aggregate.ssim.toFixed(4)}; SPZ ${(compressed.bytes / 1e6).toFixed(2)} MB; training ${trainSeconds.toFixed(1)} s.</p>
${scores.views.map((view) => `<article><h2>${view.file}: ${view.psnrDb?.toFixed(2) ?? 'infinite'} dB / SSIM ${view.ssim.toFixed(4)}</h2><img alt="Reference ${view.file}" src="reference/${view.file}"><img alt="Reconstructed ${view.file}" src="eval_${steps}/${view.file}"></article>`).join('\n')}`;
    writeFileSync(join(out, 'review.html'), html);
    writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`Measured ${scores.views.length} held-out views: PSNR ${scores.aggregate.psnrDb?.toFixed(3) ?? 'infinite'} dB, SSIM ${scores.aggregate.ssim.toFixed(4)}, SPZ ${(compressed.bytes / 1e6).toFixed(2)} MB. Review ${join(out, 'review.html')}`);
  } catch (error) {
    writeFileSync(join(out, 'result.json'), JSON.stringify({ status: 'failed', at: new Date().toISOString(), datasetSha256: dataset.sha256, error: String(error) }, null, 2) + '\n');
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => { console.error(String(error)); process.exitCode = 1; });
}
