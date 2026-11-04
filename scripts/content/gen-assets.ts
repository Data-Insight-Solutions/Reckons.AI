#!/usr/bin/env npx tsx
/**
 * Local asset generation: text → image → video and Gaussian splat (F58.9.1 / kb:splat-local-pipeline).
 *
 * Three tools, all on the person's own machine, all permissive:
 *
 *   image   stable-diffusion.cpp (MIT) + Z-Image-Turbo Q8 (Apache-2.0)     text → PNG → WebP
 *   video   stable-diffusion.cpp (MIT) + Wan2.2 TI2V-5B Q8 (Apache-2.0)    image → WebM
 *   splat   TripoSplat (MIT, code and weights)                               image → PLY
 *
 * Each tool is a COMMAND (kb:generation-coupling, F166): it knows nothing about Reckons.AI and is
 * accepted only by an independent check in asset-checks.ts, never by its exit code. Every stage
 * writes a receipt beside its output — tool and commit, every model file with its SHA-256 and
 * licence, prompt, seed, settings, duration, output hash and the check's verdict — so a committed
 * asset can be traced to exactly what made it.
 *
 * A GENERATED SPLAT IS INVENTED, NOT RECORDED. TripoSplat imagines the far side of an object from
 * one picture. It is decoration; the receipt and the app both say "generated".
 *
 * Usage:
 *   npm run gen:assets                                   every brief, every stage
 *   npm run gen:assets -- --brief=carved-turtle --stage=splat
 *   npm run gen:assets -- --check                        CI: verify committed outputs + receipts
 *
 * Tools and weights live OUTSIDE the repository in RECKONS_GEN_HOME (default
 * ~/.local/share/reckons/gen); scripts/content/gen-setup.sh downloads them. CI has no GPU and only
 * ever runs --check.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { checkImage, checkSplat, checkVideo, type Check } from './asset-checks.js';
import { compressSplat, verifyCompressed, type CompressedReceipt } from './splat-compress.js';
import { validateReceipt, type ScanReceipt } from './scan-room-lib.js';

const ROOT = resolve(import.meta.dirname, '../..');
const OUT_ROOT = join(ROOT, 'static/generated');
const GEN = process.env.RECKONS_GEN_HOME ?? join(homedir(), '.local/share/reckons/gen');
const SD_DIR = join(GEN, 'bin/sd-vulkan');
const VK_LIB = join(GEN, 'lib/vk/usr/lib/x86_64-linux-gnu');
const PY = join(GEN, 'venv/bin/python');
const TRIPO_SRC = join(GEN, 'src/TripoSplat');
const M = join(GEN, 'models');
const modelPath = (p: string) => resolve(M, p);
const byRole = (models: ModelFile[], role: string) => {
  const m = models.find((x) => x.role === role);
  if (!m) throw new Error(`model set has no '${role}'`);
  return modelPath(m.path);
};

/**
 * Overrides so a stage can run with an alternative model set (F183.1 gen-model-bench). Everything is
 * optional and the defaults are exactly the incumbent run: `gen:assets` passes none of them.
 */
export interface RunOpts {
  models?: ModelFile[];
  /** Extra environment for the child process, e.g. to pin one GPU. */
  env?: Record<string, string>;
  /** Extra stable-diffusion.cpp arguments (a candidate that needs a flag the incumbent does not). */
  extraArgs?: string[];
}

export interface Brief {
  slug: string; label: string; imagePrompt: string; videoPrompt: string;
  seed: number; gaussians: number; role: 'node' | 'background';
}

/** `path` is relative to RECKONS_GEN_HOME/models, or absolute (a bench candidate kept in its own folder). */
export interface ModelFile { role: string; path: string; source: string; license: string }
/** The incumbent model set per stage. The bench (gen-bench.ts, F183.1) READS this and never edits it. */
export const MODELS: Record<'image' | 'video' | 'splat', ModelFile[]> = {
  image: [
    { role: 'diffusion', path: 'zimage/z_image_turbo-Q8_0.gguf', source: 'https://huggingface.co/leejet/Z-Image-Turbo-GGUF', license: 'Apache-2.0' },
    { role: 'text encoder', path: 'zimage/Qwen3-4B-Instruct-2507-Q8_0.gguf', source: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF', license: 'Apache-2.0' },
    { role: 'vae', path: 'zimage/ae.safetensors', source: 'https://huggingface.co/Comfy-Org/z_image_turbo', license: 'Apache-2.0' },
  ],
  video: [
    { role: 'diffusion', path: 'wan22/Wan2.2-TI2V-5B-Q8_0.gguf', source: 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF', license: 'Apache-2.0' },
    { role: 'text encoder', path: 'wan22/umt5-xxl-encoder-Q8_0.gguf', source: 'https://huggingface.co/city96/umt5-xxl-encoder-gguf', license: 'Apache-2.0' },
    { role: 'vae', path: 'wan22/Wan2.2_VAE.safetensors', source: 'https://huggingface.co/QuantStack/Wan2.2-TI2V-5B-GGUF', license: 'Apache-2.0' },
  ],
  splat: ['diffusion_models/triposplat_fp16.safetensors', 'vae/triposplat_vae_decoder_fp16.safetensors',
    'vae/triposplat_vae_encoder_fp16.safetensors', 'clip_vision/dino_v3_vit_h.safetensors',
    'vae/flux2-vae.safetensors', 'background_removal/birefnet.safetensors']
    .map((p) => ({ role: p.split('/')[0], path: `triposplat/${p}`, source: 'https://huggingface.co/VAST-AI/TripoSplat', license: 'MIT' })),
};

/** Output file name per stage, inside static/generated/<slug>/. */
export const OUTPUTS = { image: 'image.webp', video: 'video.webm', splat: 'splat.ply' } as const;
export type Stage = keyof typeof OUTPUTS;

/** Capability discovery for the optional workspace runner; no model download or GPU work. */
export function generationAvailability(stage: Stage): { available: boolean; reason?: string } {
  const required = [
    ...(stage === 'splat' ? [PY, join(TRIPO_SRC, '.git')] : [join(SD_DIR, 'sd-cli')]),
    ...MODELS[stage].map(m => modelPath(m.path)),
  ];
  const missing = required.filter(path => !existsSync(path));
  if (missing.length) return { available: false, reason: `${stage}: ${missing.length} tool/model file(s) missing. Run scripts/content/gen-setup.sh on the runner machine.` };
  return { available: true };
}

/** The caller supplies a private job directory. The existing demonstration CLI keeps its paths. */
export async function generateStage(stage: Stage, brief: Brief, directory: string): Promise<StageReceipt> {
  const run = { image: stageImage, video: stageVideo, splat: stageSplat };
  return run[stage](brief, directory);
}

export interface StageReceipt {
  stage: Stage;
  tool: { name: string; license: string; version: string; repo: string };
  models: { role: string; file: string; sha256: string; bytes: number; license: string; source: string }[];
  input: { prompt?: string; image?: string; imageSha256?: string };
  settings: Record<string, string | number>;
  ranAt: string;
  durationS: number;
  output: { file: string; sha256: string; bytes: number };
  check: Check;
  /** Splat stage only (F58.9.11): a LOSSY compressed copy beside the PLY, with its own decode check. */
  compressed?: CompressedReceipt;
}
export interface Receipt { slug: string; label: string; role: Brief['role']; generated: true; stages: Partial<Record<Stage, StageReceipt>> }

// ── Hashing (weights are GBs; cache by path + size + mtime) ───────────────────

const HASH_CACHE = join(GEN, 'hash-cache.json');
async function sha256File(file: string, cache = true): Promise<string> {
  const st = statSync(file);
  const key = `${file}|${st.size}|${st.mtimeMs}`;
  const map: Record<string, string> = cache && existsSync(HASH_CACHE) ? JSON.parse(readFileSync(HASH_CACHE, 'utf8')) : {};
  if (map[key]) return map[key];
  const h = createHash('sha256');
  await new Promise<void>((ok, bad) => createReadStream(file).on('data', (d) => h.update(d)).on('end', () => ok()).on('error', bad));
  const hex = h.digest('hex');
  if (cache) { map[key] = hex; writeFileSync(HASH_CACHE, JSON.stringify(map, null, 1)); }
  return hex;
}
const sha256Bytes = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function modelEntries(stage: Stage, models: ModelFile[] = MODELS[stage]) {
  return Promise.all(models.map(async (m) => {
    const file = modelPath(m.path);
    if (!existsSync(file)) throw new Error(`missing model ${file} — run scripts/content/gen-setup.sh`);
    return { role: m.role, file: m.path.split('/').pop()!, sha256: await sha256File(file), bytes: statSync(file).size, license: m.license, source: m.source };
  }));
}

function sdVersion(): string {
  const out = execFileSync(join(SD_DIR, 'sd-cli'), ['--version'], { encoding: 'utf8', env: sdEnv() }).trim();
  return /commit\s+(\w+)/.exec(out)?.[1] ? `commit ${/commit\s+(\w+)/.exec(out)![1]} (Vulkan build)` : out.split('\n')[0];
}
function sdEnv(extra: Record<string, string> = {}) { return { ...process.env, LD_LIBRARY_PATH: `${VK_LIB}:${SD_DIR}`, ...extra }; }
function sd(args: string[], extra: Record<string, string> = {}) { execFileSync(join(SD_DIR, 'sd-cli'), args, { env: sdEnv(extra), stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 << 20 }); }

// ── Stages ────────────────────────────────────────────────────────────────────

/** Text → PNG with the image model set. The caller owns `png`. */
export function generateImagePng(prompt: string, seed: number, png: string, size = 768, o: RunOpts = {}): void {
  const m = o.models ?? MODELS.image;
  sd(['--diffusion-model', byRole(m, 'diffusion'), '--llm', byRole(m, 'text encoder'), '--vae', byRole(m, 'vae'),
    '-p', prompt, '--cfg-scale', '1.0', '--steps', '8', '-W', String(size), '-H', String(size), '--seed', String(seed), ...(o.extraArgs ?? []), '-o', png], o.env);
}

async function stageImage(b: Brief, dir: string): Promise<StageReceipt> {
  const size = 768;
  const tmp = join(dir, '.image.png'); // scratch, git-ignored, deleted once the WebP is written
  const settings = { width: size, height: size, steps: 8, cfgScale: 1, sampler: 'euler', seed: b.seed };
  const t = Date.now();
  generateImagePng(b.imagePrompt, b.seed, tmp, size);
  const out = join(dir, OUTPUTS.image);
  await sharp(tmp).webp({ quality: 88 }).toFile(out);
  rmSync(tmp, { force: true });
  return finish('image', b, dir, out, t, settings, { prompt: b.imagePrompt },
    { name: 'stable-diffusion.cpp', license: 'MIT', version: sdVersion(), repo: 'https://github.com/leejet/stable-diffusion.cpp' },
    await checkImage(out, { width: size, height: size }));
}

export const VIDEO_FRAMES = 49;

/** Image + prompt → WebM with the video model set. */
export function generateVideo(src: string, prompt: string, seed: number, out: string, frames = VIDEO_FRAMES, o: RunOpts = {}): void {
  const m = o.models ?? MODELS.video;
  sd(['-M', 'vid_gen', '--diffusion-model', byRole(m, 'diffusion'), '--t5xxl', byRole(m, 'text encoder'), '--vae', byRole(m, 'vae'),
    '-i', src, '-p', prompt, '--cfg-scale', '6.0', '--sampling-method', 'euler', '--steps', '20', '-W', '512', '-H', '512',
    '--video-frames', String(frames), '--fps', '16', '--flow-shift', '3.0', '--seed', String(seed), ...(o.extraArgs ?? []), '-o', out], o.env);
}

async function stageVideo(b: Brief, dir: string): Promise<StageReceipt> {
  const src = sourceImage(dir);
  const frames = VIDEO_FRAMES;
  const settings = { width: 512, height: 512, frames, fps: 16, steps: 20, cfgScale: 6, flowShift: 3, sampler: 'euler', seed: b.seed };
  const out = join(dir, OUTPUTS.video);
  const t = Date.now();
  generateVideo(src, b.videoPrompt, b.seed, out, frames);
  return finish('video', b, dir, out, t, settings, { prompt: b.videoPrompt, image: OUTPUTS.image, imageSha256: await sha256File(src, false) },
    { name: 'stable-diffusion.cpp', license: 'MIT', version: sdVersion(), repo: 'https://github.com/leejet/stable-diffusion.cpp' },
    checkVideo(out, { frames }));
}

/** Image → PLY with TripoSplat. `o.ckpts` / `o.src` point at an alternative weights directory or checkout. */
export function generateSplat(image: string, seed: number, gaussians: number, out: string,
  o: { ckpts?: string; src?: string; env?: Record<string, string> } = {}): { steps: number; peakGiB: number; torch: string; opacityRepaired: number } {
  const log = gpuRun(PY, ['-I', join(ROOT, 'scripts/content/triposplat_run.py'), '--src', o.src ?? TRIPO_SRC, '--ckpts', o.ckpts ?? join(M, 'triposplat'),
    '--image', image, '--out', out, '--gaussians', String(gaussians), '--seed', String(seed)], o.env);
  return JSON.parse(log.trim().split('\n').pop()!);
}

async function stageSplat(b: Brief, dir: string): Promise<StageReceipt> {
  const src = sourceImage(dir);
  const out = join(dir, OUTPUTS.splat);
  const t = Date.now();
  const run = generateSplat(src, b.seed, b.gaussians, out);
  const commit = execFileSync('git', ['-C', TRIPO_SRC, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const r = await finish('splat', b, dir, out, t,
    { gaussians: b.gaussians, steps: run.steps, seed: b.seed, peakGiB: run.peakGiB, torch: run.torch,
      // Upstream writes +inf opacities; triposplat_run.py clamps them and says how many (see there).
      opacityRepaired: run.opacityRepaired },
    { image: OUTPUTS.image, imageSha256: await sha256File(src, false) },
    { name: 'TripoSplat', license: 'MIT', version: `commit ${commit}`, repo: 'https://github.com/VAST-AI-Research/TripoSplat' },
    checkSplat(out, { count: b.gaussians }));
  if (r.check.pass) r.compressed = compressSplat(out);
  return r;
}

/**
 * The COMMITTED WebP, never a scratch file: the receipt records its hash, so anyone holding the
 * repository can re-run the video or splat stage from exactly the input this run used.
 */
function sourceImage(dir: string): string {
  const webp = join(dir, OUTPUTS.image);
  if (existsSync(webp)) return webp;
  throw new Error(`no image in ${dir}; run the image stage first`);
}

/**
 * Run a GPU command, retrying ONCE on "CUDA driver initialization failed". Seen 2026-10-14 when a
 * TripoSplat run started seconds after another GPU process exited; the same command succeeded on
 * retry. Any other failure is thrown at once.
 */
function gpuRun(cmd: string, args: string[], env?: Record<string, string>): string {
  for (let attempt = 1; ; attempt++) {
    try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env: { ...process.env, ...env } } : {}) }); }
    catch (e) {
      const err = String((e as { stderr?: string }).stderr ?? e);
      if (attempt >= 2 || !/CUDA driver initialization failed/.test(err)) throw e;
      console.warn('  CUDA driver initialization failed; retrying once in 10 s');
      execFileSync('sleep', ['10']);
    }
  }
}

async function finish(stage: Stage, _b: Brief, _dir: string, out: string, t: number, settings: StageReceipt['settings'],
  input: StageReceipt['input'], tool: StageReceipt['tool'], check: Check): Promise<StageReceipt> {
  const bytes = readFileSync(out);
  return {
    stage, tool, models: await modelEntries(stage), input, settings,
    ranAt: new Date(t).toISOString(), durationS: Math.round((Date.now() - t) / 100) / 10,
    output: { file: OUTPUTS[stage], sha256: sha256Bytes(bytes), bytes: bytes.length }, check,
  };
}

// ── Check mode (CI) ──────────────────────────────────────────────────────────

/** Re-run every check and confirm each committed file is the one its receipt describes. */
export async function checkCommitted(root = OUT_ROOT): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  if (!existsSync(root)) return { ok: false, lines: [`no ${root}`] };
  for (const slug of readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory()).sort()) {
    // A SYNTHETIC asset (scripts/content/synthetic-room.ts) is written by arithmetic, not a model:
    // it has no stages, only a hash and the splat check.
    const synth = join(root, slug, 'synthetic.json');
    if (existsSync(synth)) {
      const s = JSON.parse(readFileSync(synth, 'utf8')) as { output: { file: string; sha256: string } };
      const file = join(root, slug, s.output.file);
      if (!existsSync(file)) { ok = false; lines.push(`✗ ${slug}: ${s.output.file} missing`); continue; }
      const check = checkSplat(file);
      const problems = [...(sha256Bytes(readFileSync(file)) === s.output.sha256 ? [] : ['file differs from its receipt']), ...check.problems];
      if (problems.length) { ok = false; lines.push(`✗ ${slug} (synthetic): ${problems.join('; ')}`); }
      else lines.push(`✓ ${slug} (synthetic): ${s.output.file} ${JSON.stringify(check.measured)}`);
      continue;
    }
    const rfile = join(root, slug, 'receipt.json');
    if (!existsSync(rfile)) { ok = false; lines.push(`✗ ${slug}: no receipt.json`); continue; }
    const parsed = JSON.parse(readFileSync(rfile, 'utf8')) as Receipt | ScanReceipt;
    // A RECONSTRUCTED room (scan:room --export): only the compressed splat is committed, so that is what is verified.
    if ('origin' in parsed && parsed.origin === 'reconstructed') {
      const scan = parsed;
      const problems = [...validateReceipt(scan), ...(scan.compressed ? verifyCompressed(join(root, slug), scan.compressed) : ['no compressed copy in the receipt'])];
      if (problems.length) { ok = false; lines.push(`✗ ${slug} (reconstructed): ${problems.join('; ')}`); }
      else lines.push(`✓ ${slug} (reconstructed${scan.synthetic ? ' from a synthetic video' : ''}): ${scan.compressed!.file} ${scan.compressed!.gaussians} Gaussians, ${(scan.compressed!.bytes / 1e6).toFixed(2)} MB (${scan.compressed!.ratio}x, lossy, decode-checked)`);
      continue;
    }
    const receipt = parsed as Receipt;
    for (const stage of Object.keys(OUTPUTS) as Stage[]) {
      const r = receipt.stages[stage];
      if (!r) { ok = false; lines.push(`✗ ${slug}/${stage}: no receipt for this stage`); continue; }
      const file = join(root, slug, r.output.file);
      if (!existsSync(file)) { ok = false; lines.push(`✗ ${slug}/${stage}: ${r.output.file} missing`); continue; }
      const hash = sha256Bytes(readFileSync(file));
      const check = stage === 'image' ? await checkImage(file) : stage === 'video' ? checkVideo(file) : checkSplat(file, { count: Number(r.settings.gaussians) });
      const problems = [...(hash === r.output.sha256 ? [] : ['file differs from its receipt']), ...check.problems];
      if (stage === 'splat' && r.compressed) problems.push(...verifyCompressed(join(root, slug), r.compressed));
      if (problems.length) { ok = false; lines.push(`✗ ${slug}/${stage}: ${problems.join('; ')}`); }
      else lines.push(`✓ ${slug}/${stage}: ${r.output.file} ${JSON.stringify(check.measured)}${r.compressed ? `  + ${r.compressed.file} ${(r.compressed.bytes / 1e6).toFixed(2)} MB (${r.compressed.ratio}x, lossy, decode-checked)` : ''}${check.notes.length ? '  note: ' + check.notes.join('; ') : ''}`);
    }
  }
  return { ok, lines };
}

// ── The example space (static/starter-generated-assets.ttl) ──────────────────

export const EXAMPLE_TTL = join(ROOT, 'static/starter-generated-assets.ttl');
const lit = (v: string | number) => JSON.stringify(String(v));
const KIND: Record<Stage, string> = { image: 'Image', video: 'Video', splat: 'GaussianSplat' };
const MODEL_NAMES: Record<Stage, string> = {
  image: 'Z-Image-Turbo (Q8) on stable-diffusion.cpp',
  video: 'Wan2.2 TI2V-5B (Q8) on stable-diffusion.cpp',
  splat: 'TripoSplat',
};

/**
 * The example space, written FROM the receipts so it cannot claim a model, a licence or a timing
 * that the run did not record. Each output is its own node, linked back to what it was made from,
 * so the graph itself shows the pipeline: prompt → image → video, and image → splat.
 */
export function exampleTtl(receipts: Receipt[]): string {
  const out: string[] = [
    '## Generated assets — made on this machine by local models (F58.9, kb:splat-local-pipeline).',
    '## WRITTEN BY scripts/content/gen-assets.ts FROM static/generated/*/receipt.json. Do not hand-edit;',
    '## regenerate with `npm run gen:assets -- --ttl`. Every prompt is synthetic.',
    '',
    '@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix ktype: <urn:kbase:type/> .',
    '@prefix kb:    <urn:kbase:concept/> .',
    '@prefix p:     <urn:kbase:predicate/> .',
    '@prefix schema: <https://schema.org/> .',
    '@prefix story: <urn:reckons:story/> .',
    '',
    '## ktype:Prompt, Image, Video, GaussianSplat and License are built-in entity types (F58.9.5); no type is defined here.',
    '',
    'kb:generated-assets rdf:type ktype:Concept ;',
    '    rdfs:label "Generated on this machine" ;',
    `    rdfs:comment ${lit('Pictures, clips and Gaussian splats made by local models from made-up prompts. Each one is linked to what it was made from, and carries the model, license and time its run recorded. A generated splat is invented from one picture: it is decoration, not a record of anything real.')} ;`,
    `    p:has ${receipts.map((r) => `kb:gen-${r.slug}-prompt`).join(', ')} .`,
    '',
  ];
  out.push(
    'story:create-generated-asset rdf:type story:Story ;',
    '    rdfs:label "Create an asset with Shelly" ;',
    '    story:description "Describe an image, generate it locally, then choose a video, Gaussian splat or another image." ;',
    '    story:interaction "generate-assets" ;',
    '    story:autoplay "false" .',
    '',
    'story:generate-image rdf:type story:Step ;',
    '    story:partOf story:create-generated-asset ;',
    '    story:order "1" ;',
    '    story:title "Imagine an image" ;',
    '    story:content "Shelly asks for your image prompt and waits for the local runner to produce a checked result." ;',
    '    story:question "What image would you like me to generate?" .',
    '',
    'story:derive-asset rdf:type story:Step ;',
    '    story:partOf story:create-generated-asset ;',
    '    story:order "2" ;',
    '    story:title "Choose what happens next" ;',
    '    story:content "Once the image is ready, choose an available derivation. Each output links back to its source image." ;',
    '    story:question "Would you like a video, a Gaussian splat, or another image?" .',
    '',
  );
  // License is an entity: assets LINK to it (an edge between two entities), and it carries its own
  // SPDX id and URL as attributes. Ids and URLs come from the SPDX list, never from the receipt text.
  const licenses = [...new Set(receipts.flatMap((r) => Object.values(r.stages).flatMap((st) => st ? [st.tool.license, ...st.models.map((m) => m.license)] : [])))].sort();
  const licId = (l: string) => `kb:license-${l.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  for (const l of licenses) {
    out.push(`${licId(l)} rdf:type ktype:License ;`, `    rdfs:label ${lit(l)} ;`,
      `    p:spdx-id ${lit(l)} ;`, `    p:license-url ${lit(`https://spdx.org/licenses/${l}.html`)} .`, '');
  }
  for (const r of receipts) {
    const img = r.stages.image;
    const id = (k: string) => `kb:gen-${r.slug}-${k}`;
    out.push(`${id('prompt')} rdf:type ktype:Prompt ;`, `    rdfs:label ${lit(`Prompt: ${r.label}`)} ;`,
      `    rdfs:comment ${lit(img?.input.prompt ?? '')} .`, '');
    for (const stage of Object.keys(OUTPUTS) as Stage[]) {
      const st = r.stages[stage];
      if (!st) continue;
      const noun = stage === 'image' ? 'Image' : stage === 'video' ? 'Video' : 'Splat';
      const media = stage === 'image' ? 'p:photo' : stage === 'video' ? 'p:video' : 'p:splat';
      const lines = [
        `${id(stage)} rdf:type ktype:${KIND[stage]} ;`,
        `    rdfs:label ${lit(`${noun}: ${r.label.toLowerCase()}`)} ;`,
        `    ${media} ${lit(`/generated/${r.slug}/${st.output.file}`)} ;`,
        `    p:made-from ${stage === 'image' ? id('prompt') : id('image')} ;`,
        `    p:generated-with ${lit(MODEL_NAMES[stage])} ;`,
        `    schema:license ${[...new Set([st.tool.license, ...st.models.map((m) => m.license)])].sort().map(licId).join(', ')} ;`,
        `    p:generated-duration ${lit(`${st.durationS} s`)} ;`,
        // Attributes, not nodes: these predicates are metadata (GENERATION_PROVENANCE_PREDICATES in
        // src/lib/rdf/types.ts), so the detail panel lists them and the graph draws no node for them.
        `    p:generated-seed ${lit(st.settings.seed ?? '')} ;`,
      ];
      if (stage === 'video') lines.push(`    p:generated-frames ${lit(st.check.measured.frames ?? '')} ;`, `    rdfs:comment ${lit(st.input.prompt ?? '')} ;`);
      if (stage === 'splat') lines.push(`    p:generated-gaussians ${lit(Number(st.settings.gaussians))} ;`,
        `    rdfs:comment ${lit(r.role === 'background' ? 'Open it and choose Set as background to put this island behind the graph.' : 'Invented from one picture by TripoSplat: the far side is a guess.')} ;`);
      lines.push(`    p:generated-at ${lit(st.ranAt.slice(0, 10))} .`, '');
      out.push(...lines);
    }
  }
  return out.join('\n');
}

function readReceipts(root = OUT_ROOT): Receipt[] {
  return readdirSync(root).filter((d) => existsSync(join(root, d, 'receipt.json'))).sort()
    .map((d) => JSON.parse(readFileSync(join(root, d, 'receipt.json'), 'utf8')) as Receipt | ScanReceipt)
    .filter((r): r is Receipt => !('origin' in r)); // a published scan has its own receipt shape and no generated stages
}

// ── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  if (process.argv.includes('--check')) {
    const { ok, lines } = await checkCommitted();
    console.log(lines.join('\n'));
    process.exit(ok ? 0 : 1);
  }
  if (process.argv.includes('--ttl')) {
    writeFileSync(EXAMPLE_TTL, exampleTtl(readReceipts()));
    console.log(`wrote ${EXAMPLE_TTL}`);
    process.exit(0);
  }
  const { briefs } = JSON.parse(readFileSync(join(ROOT, 'scripts/content/gen-briefs.json'), 'utf8')) as { briefs: Brief[] };
  const only = arg('brief');
  const stageArg = arg('stage') ?? 'image,video,splat';
  // --stage=compress: add the compressed copy to splats that already exist (no GPU, no regeneration).
  const backfill = stageArg === 'compress';
  const stages = (backfill ? '' : stageArg).split(',').filter(Boolean) as Stage[];
  let failed = false;
  for (const b of briefs.filter((x) => !only || x.slug === only)) {
    const dir = join(OUT_ROOT, b.slug);
    mkdirSync(dir, { recursive: true });
    const rfile = join(dir, 'receipt.json');
    const receipt: Receipt = existsSync(rfile) ? JSON.parse(readFileSync(rfile, 'utf8'))
      : { slug: b.slug, label: b.label, role: b.role, generated: true, stages: {} };
    Object.assign(receipt, { label: b.label, role: b.role });
    if (backfill) {
      const sp = receipt.stages.splat;
      if (!sp) { console.log(`${b.slug} / compress … no splat stage yet`); failed = true; continue; }
      sp.compressed = compressSplat(join(dir, sp.output.file));
      writeFileSync(rfile, JSON.stringify(receipt, null, 2) + '\n');
      console.log(`${b.slug} / compress … ${sp.compressed.check.pass ? 'accepted' : 'REJECTED'} ${sp.compressed.file} ${sp.compressed.bytes} bytes, ${sp.compressed.ratio}x`);
      if (!sp.compressed.check.pass) failed = true;
      continue;
    }
    for (const stage of stages) {
      process.stdout.write(`${b.slug} / ${stage} … `);
      const r = stage === 'image' ? await stageImage(b, dir) : stage === 'video' ? await stageVideo(b, dir) : await stageSplat(b, dir);
      receipt.stages[stage] = r;
      writeFileSync(rfile, JSON.stringify(receipt, null, 2) + '\n');
      console.log(`${r.check.pass ? 'accepted' : 'REJECTED'} in ${r.durationS}s ${JSON.stringify(r.check.measured)}`
        + (r.check.problems.length ? ` problems: ${r.check.problems.join('; ')}` : '')
        + (r.check.notes.length ? ` notes: ${r.check.notes.join('; ')}` : ''));
      if (!r.check.pass) failed = true;
    }
  }
  writeFileSync(EXAMPLE_TTL, exampleTtl(readReceipts()));
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
