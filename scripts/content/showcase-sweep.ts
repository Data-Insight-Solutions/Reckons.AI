#!/usr/bin/env npx tsx
/**
 * Showcase sweep (F58.9 / kb:showcase-splat): how far does the local image -> splat pipeline go on
 * one machine, and what does each step up cost? Every run is MEASURED, never estimated:
 *
 *   - GPU memory: the run's OWN processes only, from nvidia-smi --query-compute-apps (the same
 *     monitor the F183 gen-model-bench uses, startVramMonitor in gen-bench.ts), so another lane's job
 *     on the card is not counted. Also torch's allocator peak, reported by triposplat_run.py.
 *   - System RAM: the child's peak resident memory (ru_maxrss), reported by triposplat_run.py.
 *   - Time: wall clock including model load, and the generate part separately.
 *   - Sizes: PLY and SPZ bytes. Validity: checkSplat (the same independent check gen:check uses).
 *
 *   npx tsx scripts/content/showcase-sweep.ts image --prompt=... --seeds=1,2,3 --size=1024 --out=DIR
 *   npx tsx scripts/content/showcase-sweep.ts splat --image=DIR/x.webp --out=DIR [--only=id,id]
 *   npx tsx scripts/content/showcase-sweep.ts publish --out=DIR --image=DIR/x.webp --config=max-count
 *       writes static/generated/<slug>/ (image, compressed splat, receipt) from the recorded runs; the PLY stays in DIR
 *
 * Output (DIR) is outside the repository; results.jsonl gets one JSON row per run.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { checkImage, checkSplat } from './asset-checks.js';
import { VIDEO_FRAMES, generateImagePng, generateSplat, generateVideo, writeShowcase, type Brief } from './gen-assets.js';
import { pin, startVramMonitor } from './gen-bench.js';
import { compressSplat } from './splat-compress.js';

const args = process.argv.slice(3);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const gpu = Number(arg('gpu') ?? 0);
const out = resolve(arg('out') ?? '.');
mkdirSync(out, { recursive: true });
const log = (row: object) => { appendFileSync(join(out, 'results.jsonl'), JSON.stringify(row) + '\n'); console.log(JSON.stringify(row)); };

export interface Config { id: string; gaussians: number; steps: number; guidance?: number; shift?: number; canvas?: number }
export const CONFIGS: Config[] = [
  { id: 'standard', gaussians: 32768, steps: 20 },
  { id: 'g65k', gaussians: 65536, steps: 20 },
  { id: 'g131k', gaussians: 131072, steps: 20 },
  { id: 'max-count', gaussians: 262144, steps: 20 },
  { id: 'max-count-50steps', gaussians: 262144, steps: 50 },
  { id: 'max-count-canvas512', gaussians: 262144, steps: 20, canvas: 512 },
];

async function image() {
  const size = Number(arg('size') ?? 1024);
  for (const seed of (arg('seeds') ?? '42').split(',').map(Number)) {
    const png = join(out, `.img-${seed}.png`);
    const dest = join(out, `image-${size}-s${seed}.webp`);
    const stop = startVramMonitor(join(out, `.vram-img-${seed}.csv`));
    const t = Date.now();
    generateImagePng(arg('prompt')!, seed, png, size, { env: pin(gpu) });
    const seconds = (Date.now() - t) / 1000;
    const { own } = stop();
    await sharp(png).webp({ quality: 92 }).toFile(dest);
    rmSync(png, { force: true });
    const c = await checkImage(dest, { width: size, height: size });
    log({ stage: 'image', size, seed, steps: 8, seconds, peakVramMiB: own, bytes: statSync(dest).size, pass: c.pass, problems: c.problems });
  }
}

function splat() {
  const only = arg('only')?.split(',');
  for (const c of CONFIGS.filter((x) => !only || only.includes(x.id))) {
    const ply = join(out, `${c.id}.ply`);
    const stop = startVramMonitor(join(out, `.vram-${c.id}.csv`));
    const t = Date.now();
    let run: ReturnType<typeof generateSplat> | undefined, error: string | undefined;
    try { run = generateSplat(arg('image')!, Number(arg('seed') ?? 42), c.gaussians, ply, { env: pin(gpu), steps: c.steps, guidance: c.guidance, shift: c.shift, canvas: c.canvas }); }
    catch (e) { error = String((e as { stderr?: string }).stderr ?? e).split('\n').filter(Boolean).slice(-3).join(' | '); }
    const seconds = (Date.now() - t) / 1000;
    const { own } = stop();
    if (!run) { log({ stage: 'splat', config: c, seconds, peakVramMiB: own, error }); continue; }
    const check = checkSplat(ply, { count: c.gaussians });
    let spz: { bytes: number; ratio: number; pass: boolean } | undefined;
    if (check.pass) { const r = compressSplat(ply); spz = { bytes: r.bytes, ratio: r.ratio, pass: r.check.pass }; }
    log({ stage: 'splat', config: c, seconds, loadS: run.loadS, generateS: run.generateS, peakVramMiB: own, torchPeakGiB: run.peakGiB, peakRssGiB: run.peakRssGiB,
      plyBytes: statSync(ply).size, spz, pass: check.pass, problems: check.problems, opacityRepaired: run.opacityRepaired });
  }
}

/** Image at the standard 768 px and the 49-frame video, measured the same way, for the requirements table. Run under `/usr/bin/time -v` for system RAM. */
function standardStages() {
  const which = arg('stage')!;
  const stop = startVramMonitor(join(out, `.vram-std-${which}.csv`));
  const t = Date.now();
  if (which === 'image768') generateImagePng(arg('prompt')!, 42, join(out, '.std.png'), 768, { env: pin(gpu) });
  else generateVideo(arg('image')!, arg('prompt')!, 42, join(out, 'std-video.webm'), VIDEO_FRAMES, { env: pin(gpu) });
  const seconds = (Date.now() - t) / 1000;
  log({ stage: which, seconds, peakVramMiB: stop().own });
}

async function publish() {
  const brief = JSON.parse(readFileSync(join(import.meta.dirname, 'showcase-brief.json'), 'utf8')) as Brief;
  const rows = readFileSync(join(out, 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const img = rows.filter((r) => r.stage === 'image' && r.seed === brief.seed).pop();
  const sp = rows.filter((r) => r.stage === 'splat' && r.config?.id === arg('config') && !r.error).pop();
  if (!img || !sp) throw new Error('no recorded image run for the brief seed, or no splat run for --config');
  const c = sp.config as Config;
  const r = await writeShowcase(brief, { image: arg('image')!, ply: join(out, `${c.id}.ply`), imageRun: img,
    splatRun: { seconds: sp.seconds, peakVramMiB: sp.peakVramMiB, steps: c.steps, guidance: c.guidance ?? 3, shift: c.shift ?? 3, canvas: c.canvas ?? 1024, peakGiB: sp.torchPeakGiB, peakRssGiB: sp.peakRssGiB, opacityRepaired: sp.opacityRepaired } });
  console.log(`published ${r.slug}: splat ${(r.stages.splat!.compressed!.bytes / 1e6).toFixed(2)} MB spz`);
}

// Only when run as a command: bench-review.ts imports CONFIGS from here.
if (import.meta.url === `file://${process.argv[1]}`) {
if (process.argv[2] === 'image') await image(); else if (process.argv[2] === 'publish') await publish(); else if (process.argv[2] === 'splat') splat(); else if (process.argv[2] === 'standard') standardStages(); else { console.error('usage: image|splat'); process.exit(2); }
}
