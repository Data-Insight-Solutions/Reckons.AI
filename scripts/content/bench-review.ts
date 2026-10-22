#!/usr/bin/env npx tsx
/**
 * Review-graph bench (F183.3): one prompt, three local generation pipelines, every branch detailed,
 * the result a private graph a person reviews by eye. See bench-review-lib.ts for the design.
 *
 *   npm run bench:review -- --pipelines=image,splat,three --gpu=1 [--prompt="..."] [--models=a,b]
 *   npm run bench:review -- --emit                 rebuild the graph from results.jsonl only
 *   npm run bench:review -- --emit --publish       ALSO write a public starter copy (15 MB budget). Matt's choice, never automatic.
 *
 * Order matters: image first (pipeline A reuses its baseline image), then splat, then three.
 * Run each heavy stage under a memory cap, e.g.
 *   systemd-run --user --scope -p MemoryMax=24G npm run bench:review -- --pipelines=splat --gpu=1
 *
 * Output: reckons-workspace/kbs/bench-generation/ (gitignored) = bench-generation.ttl, results.jsonl, assets/.
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, symlinkSync, lstatSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, userInfo, homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import sharp from 'sharp';
import { Parser } from 'n3';
import { checkImage, checkSplat } from './asset-checks.js';
import { generateImagePng, generateSplat } from './gen-assets.js';
import { ask, awaitFree, pin, startVramMonitor, unload } from './gen-bench.js';
import { CONFIGS } from './showcase-sweep.js';
import { compressSplat } from './splat-compress.js';
import { renderScene, serveAssets } from './bench-review-render.js';
import {
  DEFAULT_PROMPT, IMAGE_BRANCHES, bySeed, SEEDS, SPACE_ID, THREE_PATH, assertNoLeaks, buildSpace, codePrompt, ensureImportMap, extractHtml,
  imageSettings, judgeScene, latest, plyPreview, repairPrompt, scrub, type Attempt, type Identity, type Row, type SplatConfig,
} from './bench-review-lib.js';

const ROOT = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const arg = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const flag = (k: string) => args.includes(`--${k}`);
const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const prompt = arg('prompt') ?? DEFAULT_PROMPT;
const gpu = Number(arg('gpu') ?? 0);
const dir = resolve(arg('out') ?? join(ROOT, 'reckons-workspace/kbs', SPACE_ID));
const assets = join(dir, 'assets');
const resultsFile = join(dir, 'results.jsonl');
const identity: Identity = { home: homedir(), user: userInfo().username, host: hostname() };
const SPLAT_IDS = (arg('configs') ?? 'standard,g131k,max-count,max-count-50steps,max-count-canvas512').split(',');
const BUDGET_BYTES = 15 * 1e6;

const record = (row: Row) => { appendFileSync(resultsFile, JSON.stringify(row) + '\n'); console.log(JSON.stringify(row).slice(0, 400)); };
const rows = (): Row[] => (existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row) : []);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// ── C. images ────────────────────────────────────────────────────────────────

async function imageStage() {
  await awaitFree(0);
  for (const b of IMAGE_BRANCHES) for (const seed of SEEDS) {
    const png = join(dir, `.img-${b.id}-${seed}.png`), file = `image-${b.id}-s${seed}.webp`, dest = join(assets, file);
    const stop = startVramMonitor(join(dir, '.vram.csv'));
    const t = Date.now();
    generateImagePng(prompt, seed, png, b.size, { env: pin(gpu), extraArgs: ['--steps', String(b.steps)] });
    const seconds = (Date.now() - t) / 1000;
    const { own } = stop();
    await sharp(png).webp({ quality: 90 }).toFile(dest);
    rmSync(png, { force: true });
    const c = await checkImage(dest, { width: b.size, height: b.size });
    record({ kind: 'image', prompt, branch: b.id, settings: { size: b.size, steps: b.steps }, seed, seconds, peakVramMiB: own, bytes: statSync(dest).size, pass: c.pass, problems: c.problems, file });
  }
}

// ── A. splats, all from the incumbent image ──────────────────────────────────

async function splatStage() {
  const src = latest(rows(), prompt).images.get(IMAGE_BRANCHES[0].id)?.sort(bySeed)[0];
  if (!src) throw new Error('run --pipelines=image first: the splat branches use the incumbent image branch');
  await awaitFree(0);
  const image = join(assets, src.file);
  for (const c of CONFIGS.filter((x) => SPLAT_IDS.includes(x.id)) as SplatConfig[]) {
    const ply = join(assets, `splat-${c.id}.ply`);
    const stop = startVramMonitor(join(dir, '.vram.csv'));
    const t = Date.now();
    let run: ReturnType<typeof generateSplat> | undefined, error: string | undefined;
    try { run = generateSplat(image, src.seed, c.gaussians, ply, { env: pin(gpu), steps: c.steps, guidance: c.guidance, shift: c.shift, canvas: c.canvas }); }
    catch (e) { error = String((e as { stderr?: string }).stderr ?? e).split('\n').filter(Boolean).slice(-3).join(' | '); }
    const seconds = (Date.now() - t) / 1000;
    const { own } = stop();
    if (!run) { record({ kind: 'splat', prompt, config: c, image: src.file, seconds, peakVramMiB: own, error }); continue; }
    const check = checkSplat(ply, { count: c.gaussians });
    let spzBytes: number | undefined;
    if (check.pass) { const r = compressSplat(ply); spzBytes = r.bytes; }
    const p = plyPreview(new Uint8Array(readFileSync(ply)), 512, true, 'yz');
    const previewFile = `splat-${c.id}.webp`;
    await sharp(Buffer.from(p.rgba), { raw: { width: p.width, height: p.height, channels: 4 } }).webp({ quality: 85 }).toFile(join(assets, previewFile));
    record({ kind: 'splat', prompt, config: c, image: src.file, seconds, loadS: run.loadS, generateS: run.generateS, peakVramMiB: own, peakRssGiB: run.peakRssGiB,
      torchPeakGiB: run.peakGiB, plyBytes: statSync(ply).size, spzBytes, pass: check.pass, problems: check.problems, plyFile: `splat-${c.id}.ply`, spzFile: spzBytes ? `splat-${c.id}.spz` : undefined, previewFile });
  }
}

// ── B. three.js ──────────────────────────────────────────────────────────────

const CODE_HINTS = /coder|devstral|codestral|qwen3\.|qwen3:|deepseek|starcoder|codellama/i;
const NOT_CODE = /vl|vision|embed|nuextract|moondream|granite|lfm|llama3\.2|phi|gemma|command|mistral-small/i;

async function codeModels(): Promise<string[]> {
  if (arg('models')) return arg('models')!.split(',');
  const tags = (await (await fetch(`${OLLAMA}/api/tags`)).json()) as { models: { name: string }[] };
  const order = ['qwen3-coder', 'devstral', 'qwen3.6', 'qwen3.8', 'qwen3:32b'];
  const names = tags.models.map((m) => m.name).filter((n) => CODE_HINTS.test(n) && !NOT_CODE.test(n));
  return names.sort((a, b) => (order.findIndex((o) => a.startsWith(o)) + 99) % 99 - (order.findIndex((o) => b.startsWith(o)) + 99) % 99).slice(0, 4);
}

function ollamaRssMiB(): number {
  try { return execFileSync('ps', ['-C', 'ollama', '-o', 'rss='], { encoding: 'utf8' }).split('\n').reduce((n, l) => n + (Number(l.trim()) || 0), 0) / 1024; } catch { return 0; }
}

async function write(model: string, text: string): Promise<{ reply: string; seconds: number; vram: number | null }> {
  const t = Date.now();
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(900_000),
    body: JSON.stringify({ model, stream: false, think: false, keep_alive: '5m', messages: [{ role: 'user', content: text }], options: { temperature: 0.2, num_predict: 9000, num_ctx: 16384 } }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const reply = ((await res.json()) as { message?: { content?: string } }).message?.content ?? '';
  const seconds = (Date.now() - t) / 1000;
  let vram: number | null = null;
  try { const ps = (await (await fetch(`${OLLAMA}/api/ps`)).json()) as { models: { name: string; size_vram: number }[] }; const m = ps.models.find((x) => x.name === model); if (m) vram = Math.round(m.size_vram / 1048576); } catch { /* optional */ }
  return { reply, seconds, vram };
}

async function hint(shot: string): Promise<Attempt['hint']> {
  const items: [string, string][] = [['box', 'Is there a box (a music box) in the picture?'], ['key', 'Is there a brass or gold key or crank on it?'], ['table', 'Is there a table or flat surface under it?']];
  const png = await sharp(shot).png().toBuffer();
  const checklist: Record<string, boolean | null> = {};
  for (const [k, q] of items) { const a = (await ask('qwen2.5vl:7b', png, q).catch(() => '')).toUpperCase(); checklist[k] = a.startsWith('YES') ? true : a.startsWith('NO') ? false : null; }
  await unload('qwen2.5vl:7b');
  const word = (v: boolean | null) => (v === null ? 'unclear' : v ? 'yes' : 'no');
  return { checklist, note: `qwen2.5vl:7b says box ${word(checklist.box)}, key ${word(checklist.key)}, table ${word(checklist.table)}. A guess by a small model, not a verdict.` };
}

async function threeStage() {
  const threeVersion = JSON.parse(readFileSync(join(ROOT, 'node_modules/three/package.json'), 'utf8')).version as string;
  mkdirSync(join(assets, 'three'), { recursive: true });
  for (const f of ['three.module.js', 'three.core.js']) copyFileSync(join(ROOT, 'node_modules/three/build', f), join(assets, 'three', f));
  const models = await codeModels();
  console.log('code models:', models.join(', '));
  const srv = await serveAssets(assets);
  const first = codePrompt(prompt, threeVersion);
  try {
    for (const model of models) {
      const attempts: Attempt[] = [];
      let modelVram: number | null = null, peakRss = 0, error: string | undefined;
      const sampler = setInterval(() => { peakRss = Math.max(peakRss, ollamaRssMiB()); }, 500);
      try {
        let text = first, previous = '';
        for (const label of ['first', 'repair'] as const) {
          const w = await write(model, text);
          modelVram = Math.max(modelVram ?? 0, w.vram ?? 0) || null;
          const raw = extractHtml(w.reply);
          const base = `three-${slug(model)}-${label}`;
          const a: Attempt = { label, codeSeconds: w.seconds, replyBytes: w.reply.length, htmlBytes: 0, extracted: !!raw, errors: [], hasCanvas: false, variance: 0, fps: 0, items: [], passed: 0, failed: 0 };
          if (raw) {
            const html = ensureImportMap(raw, THREE_PATH);
            a.htmlBytes = Buffer.byteLength(html); a.htmlFile = `${base}.html`; a.screenshot = `${base}.webp`;
            writeFileSync(join(assets, a.htmlFile), html);
            const s = await renderScene(srv.port, a.htmlFile, join(assets, a.screenshot), a.htmlBytes);
            Object.assign(a, { errors: s.errors.map((e) => scrub(e, identity)), hasCanvas: s.hasCanvas, variance: s.variance, fps: s.fps });
            const j = judgeScene(s); a.items = j.items; a.passed = j.passed; a.failed = j.failed;
            if (flag('hints') || arg('hints') !== '0') a.hint = await hint(join(assets, a.screenshot)).catch(() => undefined);
            previous = html;
          } else { a.items = [{ id: 'ran', pass: false, detail: 'the reply held no HTML file' }]; a.failed = 1; }
          attempts.push(a);
          if (a.failed === 0) break;
          const problem = !raw ? 'The reply contained no complete HTML file.' : a.items.filter((i) => !i.pass).map((i) => `${i.id}: ${i.detail}`).join('; ');
          text = repairPrompt(first, previous, problem);
        }
      } catch (e) { error = String((e as Error).message).slice(0, 300); }
      clearInterval(sampler);
      await unload(model);
      record({ kind: 'three', prompt, model, threeVersion, attempts, modelVramMiB: modelVram, peakRssMiB: Math.round(peakRss) || null, error });
    }
  } finally { await srv.close(); }
}

// ── Emit and publish ─────────────────────────────────────────────────────────

function toolNote(): string {
  const v = JSON.parse(readFileSync(join(ROOT, 'node_modules/three/package.json'), 'utf8')).version as string;
  return `three ${v}, TripoSplat via gen-assets, qwen2.5vl:7b hints`;
}

function emit() {
  const ttl = buildSpace(prompt, rows(), { assetBase: '/bench-generation/assets', splatExt: 'ply', identity, toolNote: toolNote() });
  new Parser().parse(ttl);
  writeFileSync(join(dir, `${SPACE_ID}.ttl`), ttl);
  console.log(`wrote ${join(dir, `${SPACE_ID}.ttl`)} (${ttl.length} bytes)`);
  // The app fetches assets from the site root, so the dev server must see them: link the folder into static/ (gitignored).
  const linkDir = join(ROOT, 'static', SPACE_ID), link = join(linkDir, 'assets');
  mkdirSync(linkDir, { recursive: true });
  try { lstatSync(link); } catch { symlinkSync(assets, link); console.log(`linked ${link} -> ${assets}`); }
}

/** Public copy: webp, SPZ only, a hard budget, and no local identifier in anything written. */
function publish() {
  const outAssets = join(ROOT, 'static/generated/bench');
  const r = rows();
  const { images, splats, threes } = latest(r, prompt);
  const files = new Set<string>();
  for (const l of images.values()) for (const x of l) files.add(x.file);
  for (const s of splats.values()) { if (s.previewFile) files.add(s.previewFile); if (s.spzFile) files.add(s.spzFile); }
  for (const t of threes.values()) for (const a of t.attempts) { if (a.htmlFile) files.add(a.htmlFile); if (a.screenshot) files.add(a.screenshot); }
  for (const f of ['three/three.module.js', 'three/three.core.js']) files.add(f);
  const sizes = [...files].filter((f) => existsSync(join(assets, f))).map((f) => [f, statSync(join(assets, f)).size] as const);
  const total = sizes.reduce((n, [, b]) => n + b, 0);
  if (total > BUDGET_BYTES) {
    const big = [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, b]) => `${f} ${(b / 1e6).toFixed(2)} MB`).join(', ');
    console.error(`REFUSING TO PUBLISH: ${(total / 1e6).toFixed(2)} MB is over the ${BUDGET_BYTES / 1e6} MB budget. Largest: ${big}.`); process.exit(4);
  }
  const ttl = buildSpace(prompt, r, { assetBase: '/generated/bench', splatExt: 'spz', identity, toolNote: toolNote(), title: 'Reckons.AI — Local generation bench (public starter)' });
  assertNoLeaks(ttl, identity, 'the public graph');
  new Parser().parse(ttl);
  const copies: [string, string][] = [];
  for (const [f] of sizes) {
    const text = f.endsWith('.html') ? readFileSync(join(assets, f), 'utf8').split('/bench-generation/assets').join('/generated/bench') : null;
    if (text !== null) assertNoLeaks(text, identity, f);
    copies.push([f, text ?? '']);
  }
  mkdirSync(join(outAssets, 'three'), { recursive: true });
  for (const [f, text] of copies) { if (f.endsWith('.html')) writeFileSync(join(outAssets, f), text); else copyFileSync(join(assets, f), join(outAssets, f)); }
  const receipt = JSON.stringify({ prompt, note: 'Measured on one machine with two RTX 3090 cards; see the graph for each branch.', rows: r.filter((x) => x.prompt === prompt).map((x) => JSON.parse(scrub(JSON.stringify(x), identity))) }, null, 2) + '\n';
  assertNoLeaks(receipt, identity, 'receipt.json');
  writeFileSync(join(outAssets, 'receipt.json'), receipt);
  writeFileSync(join(ROOT, 'static/starter-generation-bench.ttl'), ttl);
  console.log(`published static/starter-generation-bench.ttl and ${sizes.length} files under static/generated/bench/ (${(total / 1e6).toFixed(2)} MB of ${BUDGET_BYTES / 1e6} MB). Register it in the About page starter list to show it.`);
}

mkdirSync(assets, { recursive: true });
if (!flag('emit')) {
  const which = (arg('pipelines') ?? 'image,splat,three').split(',');
  if (which.includes('image')) await imageStage();
  if (which.includes('splat')) await splatStage();
  if (which.includes('three')) await threeStage();
}
emit();
if (flag('publish')) publish();
