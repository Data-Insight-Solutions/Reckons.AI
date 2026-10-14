#!/usr/bin/env npx tsx
/**
 * Benchmark one generation stage: incumbent vs a candidate, same briefs, same seeds
 * (F183.1 / kb:gen-model-bench).
 *
 *   npm run bench:gen -- --stage=image                      incumbent vs a re-run of itself (control)
 *   npm run bench:gen -- --stage=image --candidate=vnbot-ai/Z-Image-Turbo-GGUF
 *   npm run bench:gen -- --stage=image --candidate=/path/to/dir     (bench-candidate.json, or one .gguf)
 *   options: --seeds=3  --briefs=5  --gpu=N  --wait=SECONDS  --judge=qwen2.5vl:7b  --file=<weight name>
 *            --no-save  --no-pending
 *
 * WHAT IT MEASURES. Per run: did every hard check in asset-checks.ts pass; a quality number from a
 * ground truth (image: checklist items a LOCAL vision model confirms, its per-item answers saved;
 * video: motion, flicker, first-frame fidelity; splat: depth-to-width, finite values, silhouette IoU
 * of an orthographic point projection against the source image); and cost (seconds, peak VRAM from
 * nvidia-smi on the pinned GPU, weight bytes, licence). Then decide() in gen-bench-lib.ts applies the
 * rule and this script writes ONE proposal per stage to the pending queue. It never edits MODELS in
 * gen-assets.ts: replacing a model is a person's decision.
 *
 * ONE GPU, AND NOT A BUSY ONE. It pins a single GPU and refuses to start (exit 3) while any other
 * generation process (sd-cli, TripoSplat, COLMAP, Brush, another bench) or a non-Ollama GPU compute
 * process is running. It never kills anything; --wait=SECONDS polls instead. Until the GPU lease
 * (0.2.7) exists this is the only protection, and it is a race: a job that starts a second after
 * the check is not seen until the next run's check.
 *
 * LOCAL, EXCEPT ONE THING. Scoring needs no network. Fetching a candidate repo's weights does
 * (and is refused, before download, for a licence off the allowlist).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import sharp from 'sharp';
import { hfModelInfo } from '../../tests/visual/hf-model-query.js';
import { parseApps, parseGpus, APPS_QUERY, GPU_QUERY } from '../agent/session-gpu.js';
import { queueFindings } from '../offline/pending-queue.js';
import { checkImage, checkSplat, checkVideo, type Check } from './asset-checks.js';
import {
  MODELS, VIDEO_FRAMES, generateImagePng, generateSplat, generateVideo, type ModelFile, type RunOpts,
} from './gen-assets.js';
import {
  STAGE_SPECS, attributionFor, checklistScore, decide, foregroundMask, generationLock, parseYesNo, readSplatPoints,
  screenCandidate, splatQuality, splatScore, videoQuality, videoScore,
  type Arm, type BenchRun, type Decision, type GenStage,
} from './gen-bench-lib.js';
import { briefsFor, loadBenchTasks, type ImageBrief, type SplatBrief, type Tier, type VideoBrief } from './gen-bench-graph.js';

/** The answer key is read from the Testing graph (static/docs-testing.ttl), F183.2. */
const TASKS = loadBenchTasks();
const IMAGE_BRIEFS = TASKS.image;
const SEEDS = TASKS.seeds;

const ROOT = resolve(import.meta.dirname, '../..');
const GEN = process.env.RECKONS_GEN_HOME ?? join(homedir(), '.local/share/reckons/gen');
const RESULTS = join(ROOT, 'tests/bench/results');
const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const IMG = 768;

const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const flag = (k: string) => args.includes(`--${k}`);

// ── Arms: the incumbent and a candidate ──────────────────────────────────────

export interface ArmSpec {
  id: string;
  models: ModelFile[];
  extraArgs?: string[];
  license: string;
  weightBytes: number;
  /** TripoSplat only: an alternative weights directory. */
  ckpts?: string;
  control?: boolean;
  notes: string[];
}

function incumbentArm(stage: GenStage, control = false): ArmSpec {
  const root = join(GEN, 'models');
  const bytes = MODELS[stage].reduce((n, m) => n + statSync(resolve(root, m.path)).size, 0);
  return { id: control ? 'incumbent-rerun' : 'incumbent', models: MODELS[stage], license: [...new Set(MODELS[stage].map((m) => m.license))].join(' + '), weightBytes: bytes, control,
    notes: ['weights as installed by gen-setup.sh; SHA-256 per file is in the stage receipts and checked upstream by bench:gen:discover'] };
}

const sha256 = async (f: string) => { const h = createHash('sha256'); await pipeline(createReadStream(f), h); return h.digest('hex'); };

/** A candidate dir holds either bench-candidate.json (a full recipe) or one weight file that replaces the incumbent's diffusion model. */
async function candidateArm(stage: GenStage, where: string): Promise<ArmSpec> {
  let dir = where;
  if (!existsSync(where)) dir = await fetchCandidate(stage, where);
  const recipeFile = join(dir, 'bench-candidate.json');
  if (existsSync(recipeFile)) {
    const r = JSON.parse(readFileSync(recipeFile, 'utf8')) as { id: string; license: string; models: ModelFile[]; extraArgs?: string[]; notes?: string[] };
    const models = r.models.map((m) => ({ ...m, path: resolve(dir, m.path) }));
    return { id: r.id, models, extraArgs: r.extraArgs, license: r.license, weightBytes: models.reduce((n, m) => n + statSync(m.path).size, 0), notes: r.notes ?? [] };
  }
  throw new Error(`${dir} has no bench-candidate.json`);
}

/** Download a drop-in candidate's weights into RECKONS_GEN_HOME/candidates/<repo>/, never over an existing install. */
async function fetchCandidate(stage: GenStage, repo: string): Promise<string> {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`--candidate "${repo}" is neither a directory nor an owner/repo`);
  const spec = STAGE_SPECS[stage];
  const info = await hfModelInfo(repo);
  const screen = screenCandidate(info, stage);
  if (!screen.kept) throw new Error(`candidate ${repo} is refused before download: ${screen.reasons[0]}`);
  if (screen.needsRecipe) {
    throw new Error(`${repo} is a different architecture from the incumbent. Write ${join(GEN, 'candidates', repo.replace('/', '__'), 'bench-candidate.json')} naming its diffusion model, text encoder and VAE (see the format in gen-bench.ts), then pass that directory.`);
  }
  const want = arg('file');
  const sib = want ? info.siblings?.find((s) => s.rfilename === want || s.rfilename.endsWith('/' + want)) : undefined;
  const file = want ? { name: want, bytes: sib?.size ?? 0 } : screen.file!;
  if (want && !sib) throw new Error(`${repo} has no file ${want}`);
  if (file.bytes > spec.maxFileBytes) throw new Error(`${file.name} is ${(file.bytes / 1024 ** 3).toFixed(1)} GiB, over the cap`);
  const dir = join(GEN, 'candidates', repo.replace('/', '__'));
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, basename(file.name));
  if (!existsSync(dest) || statSync(dest).size !== file.bytes) {
    console.log(`downloading ${repo}/${file.name} (${(file.bytes / 1024 ** 3).toFixed(1)} GiB, ${screen.license}) -> ${dest}`);
    const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${file.name}`);
    if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(dest + '.part'));
    execFileSync('mv', [dest + '.part', dest]);
  }
  const hash = await sha256(dest);
  const lfs = info.siblings?.find((s) => s.rfilename === file.name)?.lfs?.sha256;
  if (lfs && lfs !== hash) { rmSync(dest); throw new Error(`downloaded ${file.name} does not match its published SHA-256`); }
  // Drop-in: same text encoder and VAE as the incumbent, only the diffusion file differs.
  const models: ModelFile[] = MODELS[stage].map((m) => m.role === 'diffusion'
    ? { role: 'diffusion', path: basename(file.name), source: `https://huggingface.co/${repo}`, license: screen.license! }
    : { ...m, path: resolve(GEN, 'models', m.path) });
  writeFileSync(join(dir, 'bench-candidate.json'), JSON.stringify({
    id: repo, license: screen.license, models, notes: [`sha256 ${hash}`, `repo sha ${info.sha}`, `downloaded ${new Date().toISOString().slice(0, 10)}`, 'drop-in: incumbent text encoder and VAE'],
  }, null, 2));
  return dir;
}

// ── One GPU, and nobody else on it ───────────────────────────────────────────

function nvidia(q: string[]): string { return execFileSync('nvidia-smi', q, { encoding: 'utf8' }); }

function ancestors(pid: number): number[] {
  const out = [pid];
  for (let p = pid, i = 0; i < 20; i++) {
    try { p = Number(/\) \S+ (\d+)/.exec(readFileSync(`/proc/${p}/stat`, 'utf8'))?.[1]); } catch { break; }
    if (!p) break;
    out.push(p);
  }
  return out;
}

function lockReasons(): string[] {
  const apps = parseApps(nvidia(APPS_QUERY)) ?? [];
  const ps = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n').slice(1);
  return generationLock(apps, ps, ancestors(process.pid));
}

async function awaitFree(waitS: number): Promise<void> {
  const until = Date.now() + waitS * 1000;
  for (;;) {
    const why = lockReasons();
    if (!why.length) return;
    if (Date.now() >= until) {
      console.error(`REFUSING TO RUN: another generation job holds the machine (not touched):\n  - ${why.join('\n  - ')}\nWait for it, or pass --wait=SECONDS to poll.`);
      process.exit(3);
    }
    console.log(`waiting for the machine: ${why[0]}`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

function chooseGpu(): number {
  const want = arg('gpu');
  if (want !== undefined) return Number(want);
  const gpus = parseGpus(nvidia(GPU_QUERY)) ?? [];
  return [...gpus].sort((a, b) => a.usedMiB - b.usedMiB)[0]?.index ?? 0;
}

/** Samples memory.used for every GPU into a file while a run executes (our event loop is blocked by the run, so a child does it). */
function startVramMonitor(file: string) {
  const fd = openSync(file, 'w');
  const p = spawn('nvidia-smi', ['--query-gpu=index,memory.used', '--format=csv,noheader,nounits', '-lms', '250'], { stdio: ['ignore', fd, 'ignore'] });
  // Per-process memory: Vulkan and CUDA children appear here, so the run's own footprint can be told
  // apart from another lane's job on the same card. Pids already present before the run are not ours.
  const before = new Set((parseApps(nvidia(APPS_QUERY)) ?? []).map((a) => a.pid));
  const fd2 = openSync(file + '.apps', 'w');
  const p2 = spawn('nvidia-smi', ['--query-compute-apps=timestamp,pid,process_name,used_memory', '--format=csv,noheader,nounits', '-lms', '250'], { stdio: ['ignore', fd2, 'ignore'] });
  return () => {
    p.kill(); p2.kill();
    closeSync(fd); closeSync(fd2);
    const peak = new Map<number, number>();
    for (const l of readFileSync(file, 'utf8').split('\n')) {
      const [i, m] = l.split(',').map((x) => Number(x.trim()));
      if (Number.isFinite(i) && Number.isFinite(m)) peak.set(i, Math.max(peak.get(i) ?? 0, m));
    }
    // Sum of memory held by processes that were not there before, per sample time; the peak of that sum.
    const byTime = new Map<string, number>();
    for (const l of readFileSync(file + '.apps', 'utf8').split('\n')) {
      const parts = l.split(',').map((x) => x.trim());
      const pid = Number(parts[1]), mem = Number(parts[parts.length - 1]);
      if (parts.length >= 4 && Number.isFinite(pid) && Number.isFinite(mem) && !before.has(pid) && !/ollama/i.test(parts[2])) byTime.set(parts[0], (byTime.get(parts[0]) ?? 0) + mem);
    }
    const own = byTime.size ? Math.max(...byTime.values()) : null;
    return { peak, own };
  };
}
const usedNow = (): Map<number, number> => new Map((parseGpus(nvidia(GPU_QUERY)) ?? []).map((g) => [g.index, g.usedMiB]));

// ── Measurement helpers ──────────────────────────────────────────────────────

async function rgb64(file: string): Promise<Uint8Array> {
  return new Uint8Array(await sharp(file).resize(64, 64, { fit: 'fill' }).removeAlpha().raw().toBuffer());
}

function videoFrames(file: string): Uint8Array[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', 'scale=64:64', '-pix_fmt', 'rgb24', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
  const n = 64 * 64 * 3;
  return Array.from({ length: Math.floor(raw.length / n) }, (_, i) => new Uint8Array(raw.subarray(i * n, (i + 1) * n)));
}

async function ask(model: string, png: Buffer, question: string): Promise<string> {
  const res = await fetch(`${OLLAMA}/api/generate`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: `${question}\nAnswer with exactly one word: YES or NO.`, images: [png.toString('base64')], stream: false, keep_alive: '10m',
      // num_ctx pinned small: one picture is a few thousand tokens and the model's 128k default balloons VRAM.
      options: { temperature: 0, num_predict: 12, num_ctx: 8192 } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { response?: string }).response?.trim() ?? '';
}
async function unload(model: string) {
  await fetch(`${OLLAMA}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, prompt: '', keep_alive: 0 }) }).catch(() => {});
}

// ── Running a stage ──────────────────────────────────────────────────────────

interface RunRecord extends BenchRun {
  arm: string; outFile: string; check: Pick<Check, 'pass' | 'problems' | 'notes' | 'measured'>;
  metrics: Record<string, number | string | boolean>; judge?: { id: string; question: string; raw: string; verdict: boolean | null }[];
  error?: string; peakVramByGpu: Record<string, number>;
}

async function ensureSource(brief: string, work: string, gpu: number): Promise<string> {
  const dir = join(work, 'sources');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${brief}.webp`);
  if (existsSync(out)) return out;
  const ib = IMAGE_BRIEFS.find((b) => b.slug === brief)!;
  const png = join(dir, `.${brief}.png`);
  generateImagePng(ib.prompt, SEEDS[0], png, IMG, { env: pin(gpu) });
  await sharp(png).webp({ quality: 88 }).toFile(out);
  rmSync(png, { force: true });
  return out;
}

const pin = (gpu: number): Record<string, string> => ({ CUDA_VISIBLE_DEVICES: String(gpu), GGML_VK_VISIBLE_DEVICES: String(gpu) });

async function runStage(stage: GenStage, arms: ArmSpec[], seeds: number[], nBriefs: number, tier: Tier | 'all', gpu: number, work: string, waitS: number, judgeModel: string) {
  const records: RunRecord[] = [];
  const briefs = (briefsFor(TASKS, stage, tier) as (ImageBrief | VideoBrief | SplatBrief)[]).slice(0, nBriefs);
  if (!briefs.length) throw new Error(`no ${tier} briefs for stage ${stage}`);
  for (const arm of arms) {
    const armDir = join(work, arm.id.replace(/[^\w.-]/g, '_'));
    mkdirSync(armDir, { recursive: true });
    for (const b of briefs) for (const seed of seeds) {
      await awaitFree(waitS);
      const tag = `${b.slug}-${seed}`;
      const base = used();
      const stop = startVramMonitor(join(armDir, `.vram-${tag}.csv`));
      const t = Date.now();
      let outFile = '';
      let check: Check = { pass: false, problems: ['not run'], notes: [], measured: {} };
      let metrics: RunRecord['metrics'] = {};
      let quality: number | null = null;
      let error: string | undefined;
      const o: RunOpts = { models: arm.models, extraArgs: arm.extraArgs, env: pin(gpu) };
      try {
        if (stage === 'image') {
          const png = join(armDir, `.${tag}.png`);
          outFile = join(armDir, `${tag}.webp`);
          generateImagePng((b as ImageBrief).prompt, seed, png, IMG, o);
          await sharp(png).webp({ quality: 88 }).toFile(outFile);
          rmSync(png, { force: true });
          check = await checkImage(outFile, { width: IMG, height: IMG });
        } else if (stage === 'video') {
          const vb = b as VideoBrief;
          const src = await ensureSource(vb.sourceImage, work, gpu);
          outFile = join(armDir, `${tag}.webm`);
          generateVideo(src, vb.prompt, seed, outFile, VIDEO_FRAMES, o);
          check = checkVideo(outFile, { frames: VIDEO_FRAMES });
        } else {
          const sb = b as SplatBrief;
          const src = await ensureSource(sb.sourceImage, work, gpu);
          outFile = join(armDir, `${tag}.ply`);
          generateSplat(src, seed, sb.gaussians, outFile, { ckpts: arm.ckpts, env: pin(gpu) });
          check = checkSplat(outFile, { count: sb.gaussians });
        }
      } catch (e) {
        error = String((e as { stderr?: string }).stderr ?? (e as Error).message).split('\n').filter(Boolean).slice(-3).join(' | ');
        check = { pass: false, problems: [`generation failed: ${error.slice(0, 200)}`], notes: [], measured: {} };
        quality = 0; // a run that produced nothing is a zero, not a missing value
      }
      const seconds = Math.round((Date.now() - t) / 100) / 10;
      const { peak: peaks, own } = stop();
      const peakByGpu = Object.fromEntries([...peaks].map(([i, m]) => [String(i), Math.max(0, m - (base.get(i) ?? 0))]));
      if (!error && check.pass) {
        if (stage === 'video') {
          const q = videoQuality(videoFrames(outFile), await rgb64(await ensureSource((b as VideoBrief).sourceImage, work, gpu)));
          metrics = { ...q };
          quality = videoScore(q);
        } else if (stage === 'splat') {
          const pts = readSplatPoints(new Uint8Array(readFileSync(outFile)));
          const src = await ensureSource((b as SplatBrief).sourceImage, work, gpu);
          const raw = await sharp(src).resize(128, 128, { fit: 'fill' }).removeAlpha().raw().toBuffer();
          const q = pts ? splatQuality(pts, foregroundMask(new Uint8Array(raw), 128, 128)) : null;
          metrics = q ? { ...q } : { error: 'unreadable PLY' };
          quality = q ? splatScore(q, (b as SplatBrief).expects.depthToWidth) : 0;
        }
      } else if (!error) quality = 0;
      records.push({
        arm: arm.id, brief: b.slug, seed, hardPass: check.pass, quality, seconds, peakVramMiB: own ?? peakByGpu[String(gpu)] ?? null,
        bytes: outFile && existsSync(outFile) ? statSync(outFile).size : 0, outFile: outFile.replace(ROOT + '/', ''),
        check: { pass: check.pass, problems: check.problems, notes: check.notes, measured: check.measured }, metrics, error, peakVramByGpu: peakByGpu,
      });
      console.log(`  ${arm.id.padEnd(22)} ${tag.padEnd(28)} ${check.pass ? 'pass' : 'FAIL'}  ${seconds}s  vram +${own ?? peakByGpu[String(gpu)] ?? '?'} MiB (own processes${own === null ? ' not seen; card delta' : ''})${quality !== null ? `  q=${quality.toFixed(3)}` : ''}${error ? '  ' + error.slice(0, 100) : ''}`);
    }
  }
  // Image quality needs the judge, which runs AFTER all generation so its VRAM never overlaps a measured run.
  if (stage === 'image') {
    let tags: { models?: { name: string }[] } = {};
    try { tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as typeof tags; } catch { /* handled below */ }
    const have = tags.models?.some((m) => m.name === judgeModel || m.name.startsWith(judgeModel + ':')) ?? false;
    if (!have) {
      console.error(`JUDGE UNAVAILABLE: ${judgeModel} not served at ${OLLAMA}. Image quality is NOT scored; the verdict will be insufficient-evidence.`);
      for (const r of records) if (r.hardPass) r.quality = null;
    } else {
      console.log(`judging ${records.filter((r) => r.hardPass).length} images with ${judgeModel} (num_ctx 8192, temperature 0)`);
      for (const r of records.filter((x) => x.hardPass)) {
        const png = await sharp(join(ROOT, r.outFile)).png().toBuffer();
        const brief = IMAGE_BRIEFS.find((b) => b.slug === r.brief)!;
        r.judge = [];
        for (const item of brief.checklist) {
          const raw = await ask(judgeModel, png, item.question);
          r.judge.push({ id: item.id, question: item.question, raw, verdict: parseYesNo(raw) });
        }
        r.quality = checklistScore(r.judge.map((j) => j.verdict));
        r.metrics = { confirmed: r.judge.filter((j) => j.verdict === true).length, items: r.judge.length, ambiguous: r.judge.filter((j) => j.verdict === null).length };
      }
      await unload(judgeModel);
    }
  }
  return records;
}

const used = usedNow;

const armOf = (id: string, license: string | null, recs: RunRecord[]): Arm => ({ id, license, runs: recs.filter((r) => r.arm === id) });
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const stage = arg('stage') as GenStage | undefined;
  if (!stage || !(stage in STAGE_SPECS)) { console.error('usage: npm run bench:gen -- --stage=image|video|splat [--candidate=<owner/repo | dir>] [--seeds=3] [--briefs=N] [--tier=smoke|hard|all] [--gpu=N] [--wait=S]'); process.exit(2); }
  if (arg('redecide')) { await redecide(arg('redecide')!); return; }
  const seeds = SEEDS.slice(0, Number(arg('seeds') ?? 3));
  const nBriefs = Number(arg('briefs') ?? 99);
  // Image has a hard tier with headroom (F183.2); video and splat briefs are all smoke tier today.
  const tier = (arg('tier') ?? (stage === 'image' ? 'hard' : 'all')) as Tier | 'all';
  if (!['smoke', 'hard', 'all'].includes(tier)) { console.error('--tier must be smoke, hard or all'); process.exit(2); }
  const waitS = Number(arg('wait') ?? 0);
  const judgeModel = arg('judge') ?? 'qwen2.5vl:7b';

  if (flag('fetch-only')) {
    // Downloading touches the network and the disk, not the GPU, so it does not wait for the machine.
    const dir = await fetchCandidate(stage, arg('candidate')!);
    console.log(`candidate ready in ${dir}`);
    return;
  }
  await awaitFree(waitS);
  const gpu = chooseGpu();
  console.log(`stage ${stage}  GPU ${gpu} pinned (CUDA_VISIBLE_DEVICES, GGML_VK_VISIBLE_DEVICES)  seeds ${seeds.join(',')}`);

  const cand = arg('candidate');
  const arms: ArmSpec[] = [incumbentArm(stage)];
  arms.push(cand ? await candidateArm(stage, cand) : incumbentArm(stage, true));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const work = join(RESULTS, 'gen-work', `${stage}_${stamp}`);
  mkdirSync(work, { recursive: true });

  const t0 = Date.now();
  const records = await runStage(stage, arms, seeds, nBriefs, tier, gpu, work, waitS, judgeModel);
  const [inc, other] = arms.map((a) => armOf(a.id, a.license.split(' + ')[0].toLowerCase(), records));
  const decision: Decision = decide(inc, other);
  const spreadArm = perSeedSpreadReport(inc);

  console.log(`\n=== ${stage}: ${arms[1].id} vs ${arms[0].id}${arms[1].control ? '  (CONTROL: the incumbent against a re-run of itself)' : ''} ===`);
  for (const a of arms) {
    const rs = records.filter((r) => r.arm === a.id);
    console.log(`  ${a.id.padEnd(24)} hard ${rs.filter((r) => r.hardPass).length}/${rs.length}  quality ${mean(rs.map((r) => r.quality ?? NaN)).toFixed(3)}  ${mean(rs.map((r) => r.seconds)).toFixed(1)} s/run  peak +${Math.max(...rs.map((r) => r.peakVramMiB ?? 0))} MiB  weights ${(a.weightBytes / 1024 ** 3).toFixed(1)} GiB  ${a.license}`);
  }
  console.log(`  incumbent seed-to-seed spread ${spreadArm}`);
  console.log(`  VERDICT: ${decision.verdict}${arms[1].control ? ' (control run: nothing is proposed)' : ''}\n    ${decision.reasons.join('\n    ')}`);

  const result = {
    date: new Date().toISOString(), feature: 'F183.1', stage, gpu, seeds, judge: stage === 'image' ? { model: judgeModel, num_ctx: 8192, temperature: 0 } : null,
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    arms: arms.map((a) => ({ id: a.id, license: a.license, attribution: attributionFor(a.id, a.license.split(' + ')[0].toLowerCase()), weightBytes: a.weightBytes, control: !!a.control, notes: a.notes, models: a.models.map((m) => ({ role: m.role, file: basename(m.path), source: m.source, license: m.license })) })),
    decision, runs: records,
  };
  if (!flag('no-save')) {
    mkdirSync(RESULTS, { recursive: true });
    const f = join(RESULTS, `gen-bench-${stage}_${stamp}.json`);
    writeFileSync(f, JSON.stringify(result, null, 2));
    console.log(`\nSaved ${f.replace(ROOT + '/', '')}`);
  }
  if (!flag('no-pending') && !arms[1].control) {
    queueVerdict(stage, { id: arms[1].id, license: arms[1].license }, decision, seeds, new Set(records.map((r) => r.brief)).size);
  }
}

/** Re-apply decide() to a saved result (no GPU) and re-queue its proposal, replacing the earlier line for the stage. */
async function redecide(file: string) {
  const j = JSON.parse(readFileSync(file, 'utf8')) as { stage: GenStage; seeds: number[]; arms: { id: string; license: string; control: boolean }[]; runs: RunRecord[] };
  const [a, b] = j.arms;
  const decision = decide(armOf(a.id, a.license.split(' + ')[0].toLowerCase(), j.runs), armOf(b.id, b.license.split(' + ')[0].toLowerCase(), j.runs));
  console.log(`${j.stage}: ${decision.verdict}\n  ${decision.reasons.join('\n  ')}`);
  writeFileSync(file, JSON.stringify({ ...j, decision, redecidedAt: new Date().toISOString() }, null, 2));
  if (!b.control) queueVerdict(j.stage, { id: b.id, license: b.license }, decision, j.seeds, new Set(j.runs.map((x) => x.brief)).size);
}

function queueVerdict(stage: GenStage, cand: { id: string; license?: string }, decision: Decision, seeds: number[], briefs: number) {
  const n = decision.numbers;
  const f = (x: number | null, d = 3) => (x === null ? 'n/a' : x.toFixed(d));
  const { queued } = queueFindings([{
    subject: 'urn:kbase:concept/gen-model-bench',
    predicate: `urn:kbase:predicate/bench-verdict-${stage}`,
    object: decision.verdict,
    note: `[gen-model-bench ${new Date().toISOString().slice(0, 10)}] ${stage}: candidate ${cand.id} (${cand.license ?? 'licence unknown'}${attributionFor(cand.id, cand.license) ? '; ATTRIBUTION REQUIRED: ' + attributionFor(cand.id, cand.license) : ''}) vs incumbent. Quality ${f(n.candidateQuality)} vs ${f(n.incumbentQuality)} (delta ${f(n.delta)}, incumbent seed spread ${f(n.incumbentSpread)}); time ${f(n.timeRatio, 2)}x; peak VRAM ${n.candidatePeakVramMiB ?? 'n/a'} MiB; hard-check regressions ${n.hardRegressions.length}. ${decision.reasons.join(' ')} ${seeds.length} seeds x ${briefs} briefs. Proposal only: MODELS in gen-assets.ts is not edited by the bench.`,
    type: 'suggestion', priority: decision.verdict === 'upgrade' ? 'high' : 'low',
  }], { agent: 'gen-model-bench', recomputes: true });
  console.log(`${queued} proposal queued -> reckons-workspace/knowledge.pending.jsonl`);
}

function perSeedSpreadReport(inc: Arm): string {
  const by = new Map<number, number[]>();
  for (const r of inc.runs) if (r.quality !== null) by.set(r.seed, [...(by.get(r.seed) ?? []), r.quality]);
  const means = [...by].map(([s, q]) => [s, mean(q)] as const);
  return means.length ? `${(Math.max(...means.map((m) => m[1])) - Math.min(...means.map((m) => m[1]))).toFixed(3)}  (per-seed means ${means.map(([s, m]) => `${s}:${m.toFixed(3)}`).join(' ')})` : 'n/a';
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
