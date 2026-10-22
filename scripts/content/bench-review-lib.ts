/**
 * Review-space bench, deterministic parts (F183.3). Everything here is a pure function of its
 * inputs: the settings diffs, the scene checks, the splat preview, the leak scrub and the Turtle
 * emitter. The same recorded results give the same bytes, so a test can pin them.
 *
 * Three pipelines hang off ONE prompt:
 *   C  image  : prompt -> image, one branch per image setting (same seeds on every branch)
 *   A  splat  : prompt -> ONE fixed image (the incumbent branch of C) -> splat, one branch per settings config
 *   B  three  : prompt -> scene code by a local model -> headless render -> one repair -> one branch per model
 * Every branch names only what differs from its pipeline's baseline (kpred:differs-by) and carries its measured
 * values as separate literals. A vision-model answer is a HINT beside the branch, never a pass or a fail.
 */

export const DEFAULT_PROMPT = 'an ornate wooden music box with a brass key, on a plain table';
export const SPACE_ID = 'bench-generation';
export const SEEDS = [42, 7];

// ── Settings and what differs ────────────────────────────────────────────────

export type Settings = Record<string, string | number | undefined>;

/** "gaussians 32768 -> 262144, steps 20 -> 28": only the keys whose value differs from the baseline. */
export function differsBy(baseline: Settings, cfg: Settings, labels: Record<string, string> = {}): string {
  const keys = [...new Set([...Object.keys(baseline), ...Object.keys(cfg)])];
  const parts = keys.filter((k) => String(baseline[k] ?? '') !== String(cfg[k] ?? ''))
    .map((k) => `${labels[k] ?? k} ${baseline[k] ?? 'unset'} → ${cfg[k] ?? 'unset'}`);
  return parts.length ? parts.join(', ') : 'nothing: this is the baseline branch';
}

export interface ImageBranch { id: string; size: number; steps: number }
export const IMAGE_BRANCHES: ImageBranch[] = [
  { id: 'incumbent', size: 768, steps: 8 },
  { id: 'steps-4', size: 768, steps: 4 },
  { id: 'steps-16', size: 768, steps: 16 },
  { id: 'size-1024', size: 1024, steps: 8 },
];
export const imageSettings = (b: ImageBranch): Settings => ({ size: b.size, steps: b.steps });

export interface SplatConfig { id: string; gaussians: number; steps: number; guidance?: number; shift?: number; canvas?: number }
/** TripoSplat defaults, as showcase-sweep publishes them when a config leaves a field out. */
export const splatSettings = (c: SplatConfig): Settings => ({
  gaussians: c.gaussians, steps: c.steps, guidance: c.guidance ?? 3, shift: c.shift ?? 3, canvas: c.canvas ?? 1024,
});

// ── Scene checks ─────────────────────────────────────────────────────────────

export const BLANK_VARIANCE = 5;
export const MIN_FPS = 5;
export const MAX_HTML_BYTES = 200_000;

export interface SceneStats { errors: string[]; hasCanvas: boolean; variance: number; fps: number; htmlBytes: number }
export interface CheckItem { id: string; pass: boolean; detail: string }

export function judgeScene(s: SceneStats): { items: CheckItem[]; passed: number; failed: number } {
  const items: CheckItem[] = [
    { id: 'ran', pass: s.errors.length === 0 && s.hasCanvas, detail: s.errors.length ? `${s.errors.length} console error(s): ${s.errors[0]}` : s.hasCanvas ? 'no console errors, canvas present' : 'no canvas element' },
    { id: 'not-blank', pass: s.variance >= BLANK_VARIANCE, detail: `luminance variance ${s.variance.toFixed(1)} (blank below ${BLANK_VARIANCE})` },
    { id: 'fps', pass: s.fps >= MIN_FPS, detail: `${s.fps.toFixed(1)} frames per second over 5 s (software rendering, so a floor and not a target)` },
    { id: 'size', pass: s.htmlBytes <= MAX_HTML_BYTES, detail: `${s.htmlBytes} bytes (limit ${MAX_HTML_BYTES})` },
  ];
  const passed = items.filter((i) => i.pass).length;
  return { items, passed, failed: items.length - passed };
}

/** Variance of luminance over RGBA pixels (0..255 scale). */
export function luminanceVariance(rgba: Uint8Array | Uint8ClampedArray): number {
  const n = rgba.length >> 2;
  if (!n) return 0;
  let sum = 0, sum2 = 0;
  for (let i = 0; i < n; i++) {
    const l = 0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2];
    sum += l; sum2 += l * l;
  }
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

// ── Scene code: prompts and extraction ───────────────────────────────────────

export const THREE_PATH = '/bench-generation/assets/three';

export function codePrompt(scene: string, threeVersion: string): string {
  return [
    `Write ONE self-contained HTML file that renders this scene with three.js r${threeVersion.split('.')[1]} (version ${threeVersion}): ${scene}.`,
    'Rules: import three only as `import * as THREE from "three"` inside a `<script type="module">`; no other imports, no addons, no external files, no network.',
    'Build everything from primitives and procedural materials (no textures). Add lights, a camera that frames the whole subject, and a slow animation loop with requestAnimationFrame.',
    'Create a WebGLRenderer, append its canvas to document.body, fill the window. Reply with the complete HTML file only, inside one ```html fenced block.',
  ].join('\n');
}

export function repairPrompt(original: string, code: string, problem: string): string {
  return `${original}\n\nYour previous file did not work.\nProblem: ${problem}\n\nPrevious file:\n\`\`\`html\n${code}\n\`\`\`\n\nFix it and reply with the complete corrected HTML file only, inside one \`\`\`html fenced block.`;
}

/** The HTML out of a model reply: the fenced block, or from <!doctype/<html to </html>. Null when there is none. */
export function extractHtml(reply: string): string | null {
  const fence = /```(?:html)?\s*\n([\s\S]*?)```/i.exec(reply);
  const body = fence ? fence[1] : reply;
  const m = /<!doctype html[\s\S]*<\/html>|<html[\s\S]*<\/html>/i.exec(body);
  const html = (m ? m[0] : fence ? fence[1] : '').trim();
  return /<script/i.test(html) ? html + '\n' : null;
}

/** Make `import "three"` resolve to the locally served copy. Replaces any import map the model wrote. */
export function ensureImportMap(html: string, base = THREE_PATH): string {
  const map = `<script type="importmap">{"imports":{"three":"${base}/three.module.js"}}</script>`;
  const stripped = html.replace(/<script[^>]*type=["']importmap["'][^>]*>[\s\S]*?<\/script>\s*/gi, '');
  return /<head[^>]*>/i.test(stripped) ? stripped.replace(/<head[^>]*>/i, (h) => `${h}\n${map}`) : map + '\n' + stripped;
}

// ── Splat preview (CPU, from the PLY) ────────────────────────────────────────

/**
 * A flat front preview of a Gaussian splat PLY: each Gaussian a small coloured square, drawn back to front.
 * It shows density and coverage so branches can be told apart at a glance; it is NOT a splat renderer.
 */
export function plyPreview(ply: Uint8Array, size = 512, flipDepth = false): { width: number; height: number; rgba: Uint8Array } {
  const marker = new TextEncoder().encode('end_header\n');
  let end = -1;
  for (let i = 0; i < Math.min(ply.length - marker.length, 65536) && end < 0; i++) {
    let ok = true;
    for (let j = 0; j < marker.length; j++) if (ply[i + j] !== marker[j]) { ok = false; break; }
    if (ok) end = i + marker.length;
  }
  if (end < 0) throw new Error('not a PLY: no end_header');
  const header = new TextDecoder().decode(ply.subarray(0, end));
  const count = Number(/element vertex (\d+)/.exec(header)?.[1] ?? 0);
  const props: string[] = [];
  for (const m of header.matchAll(/property (\w+) (\w+)/g)) { if (m[1] !== 'float' && m[1] !== 'float32') throw new Error(`preview needs float properties, got ${m[1]} ${m[2]}`); props.push(m[2]); }
  const stride = props.length * 4;
  const at = (n: string) => props.indexOf(n);
  const [ix, iy, iz, r0, g0, b0, io] = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity'].map(at);
  if ([ix, iy, iz, r0, g0, b0, io].some((i) => i < 0)) throw new Error('PLY lacks x/y/z/f_dc/opacity');
  const dv = new DataView(ply.buffer, ply.byteOffset + end, count * stride);
  const f = (i: number, p: number) => dv.getFloat32(i * stride + p * 4, true);
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < count; i++) { const x = f(i, ix), y = f(i, iy); if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); } }
  const pct = (a: number[], q: number) => { const s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? 0; };
  const x0 = pct(xs, 0.01), x1 = pct(xs, 0.99), y0 = pct(ys, 0.01), y1 = pct(ys, 0.99);
  const span = Math.max(x1 - x0, y1 - y0, 1e-6) * 1.08;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => (flipDepth ? -1 : 1) * (f(b, iz) - f(a, iz)));
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 236; rgba[i * 4 + 3] = 255; }
  const c = (v: number) => Math.max(0, Math.min(255, Math.round((0.5 + 0.28209479 * v) * 255)));
  for (const i of order) {
    const a = 1 / (1 + Math.exp(-f(i, io)));
    if (!(a > 0.25)) continue;
    const px = Math.round((f(i, ix) - cx) / span * size + size / 2), py = Math.round(-(f(i, iy) - cy) / span * size + size / 2);
    const col = [c(f(i, r0)), c(f(i, g0)), c(f(i, b0))];
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const X = px + dx, Y = py + dy;
      if (X < 0 || Y < 0 || X >= size || Y >= size) continue;
      const o = (Y * size + X) * 4; rgba[o] = col[0]; rgba[o + 1] = col[1]; rgba[o + 2] = col[2];
    }
  }
  return { width: size, height: size, rgba };
}

// ── Leaks ────────────────────────────────────────────────────────────────────

export interface Identity { home: string; user: string; host: string }

/** Remove local paths, ports, user and host names from any text that reaches a space or receipt. */
export function scrub(text: string, id: Identity): string {
  let t = text;
  if (id.home) t = t.split(id.home).join('~');
  t = t.replace(/\/home\/[A-Za-z0-9._-]+/g, '~').replace(/\/Users\/[A-Za-z0-9._-]+/g, '~');
  t = t.replace(/https?:\/\/(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::\d+)?/g, '');
  for (const w of [id.user, id.host]) if (w && w.length > 2) t = t.split(w).join('<local>');
  return t;
}

/** Throws with the first leak found; the public copy refuses to be written when it holds a local name. */
export function assertNoLeaks(text: string, id: Identity, what: string): void {
  const bad: string[] = [];
  if (id.home && text.includes(id.home)) bad.push('home directory');
  if (/\/home\/[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+/.test(text)) bad.push('absolute home path');
  if (/(?:127\.0\.0\.1|localhost):\d+/.test(text)) bad.push('localhost address');
  if (id.user && id.user.length > 2 && text.includes(id.user)) bad.push('user name');
  if (id.host && id.host.length > 2 && text.includes(id.host)) bad.push('host name');
  if (bad.length) throw new Error(`${what} would publish a local identifier (${bad.join(', ')}); refusing`);
}

// ── Results (one JSON row per run in results.jsonl) ──────────────────────────

export interface Common { prompt: string }
export interface ImageRow extends Common {
  kind: 'image'; branch: string; settings: { size: number; steps: number }; seed: number;
  seconds: number; peakVramMiB: number | null; bytes: number; pass: boolean; problems: string[]; file: string;
}
export interface SplatRow extends Common {
  kind: 'splat'; config: SplatConfig; image: string; seconds?: number; loadS?: number; generateS?: number;
  peakVramMiB?: number | null; peakRssGiB?: number; torchPeakGiB?: number; plyBytes?: number; spzBytes?: number;
  pass?: boolean; problems?: string[]; error?: string; plyFile?: string; spzFile?: string; previewFile?: string;
}
export interface Attempt {
  label: 'first' | 'repair'; codeSeconds: number; replyBytes: number; htmlBytes: number; htmlFile?: string; extracted: boolean;
  errors: string[]; hasCanvas: boolean; variance: number; fps: number; items: CheckItem[]; passed: number; failed: number;
  screenshot?: string; hint?: { checklist: Record<string, boolean | null>; note: string };
}
export interface ThreeRow extends Common {
  kind: 'three'; model: string; threeVersion: string; attempts: Attempt[];
  modelVramMiB: number | null; peakRssMiB: number | null; error?: string;
}
export type Row = ImageRow | SplatRow | ThreeRow;

/** The latest row per branch for one prompt, in the order the branches are defined. */
export function latest(rows: Row[], prompt: string) {
  const mine = rows.filter((r) => r.prompt === prompt);
  const images = new Map<string, ImageRow[]>();
  for (const r of mine) if (r.kind === 'image') {
    const list = (images.get(r.branch) ?? []).filter((x) => x.seed !== r.seed); list.push(r); images.set(r.branch, list);
  }
  const splats = new Map<string, SplatRow>(), threes = new Map<string, ThreeRow>();
  for (const r of mine) { if (r.kind === 'splat') splats.set(r.config.id, r); if (r.kind === 'three') threes.set(r.model, r); }
  return { images, splats, threes };
}

// ── Turtle emitter ───────────────────────────────────────────────────────────

const lit = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t') + '"';
const int = (n: number) => `"${Math.round(n)}"^^xsd:integer`;
const dec = (n: number, d = 1) => `"${n.toFixed(d)}"^^xsd:decimal`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

export interface EmitOptions {
  /** URL prefix of the asset files as the app will fetch them (rooted). */
  assetBase: string;
  /** Which splat file the node opens. The public copy ships the compressed SPZ only. */
  splatExt: 'ply' | 'spz';
  identity: Identity;
  /** Provenance line for the root: the model and tool versions of the run. */
  toolNote: string;
  title?: string;
}

/** Each key is a predicate under the shared p: namespace; measured values are separate literals. */
export const BENCH_PREDICATES = ['differs-by', 'seconds', 'peak-vram-mib', 'peak-ram-mib', 'output-bytes', 'checks-passed', 'checks-failed', 'fps', 'vision-hint', 'scene-file'];

interface Node { id: string; label: string; comment: string; lines: string[]; layer: number; children: string[]; verdict: boolean }

export function buildSpace(prompt: string, rows: Row[], o: EmitOptions): string {
  const { images, splats, threes } = latest(rows, prompt);
  const S = (t: string) => scrub(t, o.identity);
  const nodes: Node[] = [];
  const add = (n: Omit<Node, 'children'> & { children?: string[] }) => { nodes.push({ children: [], ...n }); return n.id; };
  const A = (f?: string) => (f ? `${o.assetBase}/${f}` : undefined);
  const seqNav = (ids: string[], i: number) => [`hnav:order "${i + 1}"^^xsd:integer`, ...(i < ids.length - 1 ? [`hnav:next ${ids[i + 1]}`] : []), ...(i > 0 ? [`hnav:prev ${ids[i - 1]}`] : [])];
  const measure = (m: { seconds?: number; vram?: number | null; ram?: number | null; bytes?: number; passed?: number; failed?: number; fps?: number }) => [
    ...(m.seconds !== undefined ? [`p:seconds ${dec(m.seconds)}`] : []),
    ...(m.vram != null ? [`p:peak-vram-mib ${int(m.vram)}`] : []),
    ...(m.ram != null ? [`p:peak-ram-mib ${int(m.ram)}`] : []),
    ...(m.bytes !== undefined ? [`p:output-bytes ${int(m.bytes)}`] : []),
    ...(m.passed !== undefined ? [`p:checks-passed ${int(m.passed)}`] : []),
    ...(m.failed !== undefined ? [`p:checks-failed ${int(m.failed)}`] : []),
    ...(m.fps !== undefined ? [`p:fps ${dec(m.fps)}`] : []),
  ];
  const costLine = (m: Parameters<typeof measure>[0]) => [
    m.seconds !== undefined ? `${m.seconds.toFixed(1)} s` : '', m.vram != null ? `${m.vram} MiB GPU (own processes)` : '',
    m.ram != null ? `${m.ram} MiB RAM peak` : '', m.bytes !== undefined ? `${m.bytes} bytes` : '',
    m.passed !== undefined ? `checks ${m.passed} passed, ${m.failed ?? 0} failed` : '', m.fps !== undefined ? `${m.fps.toFixed(1)} fps` : '',
  ].filter(Boolean).join('; ');

  // Pipeline C: image
  const baseImg = IMAGE_BRANCHES[0];
  const present = IMAGE_BRANCHES.filter((b) => (images.get(b.id) ?? []).length);
  const imgBranchIds = present.map((b) => `bgn:image-${slug(b.id)}`);
  for (const [bi, b] of present.entries()) {
    const list = [...(images.get(b.id) ?? [])].sort((x, y) => x.seed - y.seed);
    const id = imgBranchIds[bi];
    const sec = list.reduce((n, r) => n + r.seconds, 0) / list.length;
    const vram = Math.max(...list.map((r) => r.peakVramMiB ?? 0)) || null;
    const bytes = Math.round(list.reduce((n, r) => n + r.bytes, 0) / list.length);
    const failed = list.reduce((n, r) => n + r.problems.length, 0), passed = list.filter((r) => r.pass).length;
    const seedIds = list.map((r) => `${id}-seed-${r.seed}`);
    const diff = differsBy(imageSettings(baseImg), imageSettings(b));
    add({ id, label: `Image: ${b.id}`, layer: 2, verdict: true, children: seedIds,
      comment: S(`Image branch "${b.id}" (${b.size} px, ${b.steps} steps). Differs from the baseline: ${diff}. Mean over ${list.length} seed(s) (${list.map((r) => r.seed).join(', ')}, the same on every branch): ${costLine({ seconds: sec, vram, bytes, passed, failed })}. The picture is seed ${list[0].seed}; the others are under this node. Judge by eye; the checks only say the file is a valid, non-flat image.`),
      lines: [`p:photo ${lit(A(list[0].file)!)}`, `p:differs-by ${lit(diff)}`, ...measure({ seconds: sec, vram, bytes, passed, failed }), `kmeta:review-verdict ${lit('unreviewed')}`, ...seqNav(imgBranchIds, bi)] });
    list.forEach((r, i) => add({ id: seedIds[i], label: `seed ${r.seed}`, layer: 3, verdict: false,
      comment: S(`Seed ${r.seed}: ${costLine({ seconds: r.seconds, vram: r.peakVramMiB, bytes: r.bytes, passed: r.pass ? 1 : 0, failed: r.problems.length })}.${r.problems.length ? ' Problems: ' + r.problems.join('; ') : ''}`),
      lines: [`p:photo ${lit(A(r.file)!)}`, ...seqNav(seedIds, i)] }));
  }
  // The splat input is the baseline branch's first seed, so the splat branches differ only in splat settings.
  const splatSource = [...(images.get(baseImg.id) ?? [])].sort((x, y) => x.seed - y.seed)[0];

  // Pipeline A: splat
  const splatBranchIds: string[] = [];
  const baseSplat = splatSettings({ id: 'base', gaussians: 0, steps: 0 });
  const firstSplat = [...splats.values()][0];
  const baseline = firstSplat ? splatSettings(firstSplat.config) : baseSplat;
  const configOrder = [...splats.keys()];
  for (const [i, cid] of configOrder.entries()) {
    const r = splats.get(cid)!;
    const id = `bgn:splat-${slug(cid)}`;
    splatBranchIds.push(id);
    const diff = differsBy(baseline, splatSettings(r.config));
    const m = { seconds: r.seconds, vram: r.peakVramMiB, ram: r.peakRssGiB !== undefined ? r.peakRssGiB * 1024 : undefined, bytes: r.plyBytes, passed: r.pass ? 1 : 0, failed: r.problems?.length ?? (r.error ? 1 : 0) };
    const file = o.splatExt === 'spz' ? r.spzFile : r.plyFile;
    add({ id, label: `Splat: ${cid}`, layer: 3, verdict: true,
      comment: S(r.error ? `Splat branch "${cid}" FAILED: ${r.error}. Differs from the baseline: ${diff}.` :
        `Splat branch "${cid}". Differs from the baseline (${firstSplat.config.id}): ${diff}. ${costLine(m)}${r.spzBytes !== undefined ? `; compressed SPZ ${r.spzBytes} bytes` : ''}. Every splat branch is made from the same input image (the "${baseImg.id}" image branch, seed ${splatSource?.seed}), so only the splat settings differ. The picture is a flat CPU preview of the Gaussians (density and colour, not a render); open the splat itself in the viewer for the real look.${r.problems?.length ? ' Problems: ' + r.problems.join('; ') : ''}`),
      lines: [...(r.previewFile ? [`p:photo ${lit(A(r.previewFile)!)}`] : []), ...(file && !r.error ? [`p:splat ${lit(A(file)!)}`] : []), `p:differs-by ${lit(diff)}`, ...measure(m), `kmeta:review-verdict ${lit('unreviewed')}`, ...seqNav(configOrder.map((c) => `bgn:splat-${slug(c)}`), i)] });
  }

  // Pipeline B: three.js
  const modelOrder = [...threes.keys()];
  const baseModel = modelOrder[0];
  const threeBranchIds = modelOrder.map((m) => `bgn:three-${slug(m)}`);
  for (const [i, model] of modelOrder.entries()) {
    const r = threes.get(model)!;
    const id = threeBranchIds[i];
    const last = r.attempts[r.attempts.length - 1];
    const stepIds: string[] = [];
    const steps: Node[] = [];
    r.attempts.forEach((a, k) => {
      const write = `${id}-${a.label}-write`, render = `${id}-${a.label}-render`;
      stepIds.push(write, render);
      steps.push({ id: write, label: a.label === 'first' ? 'Write scene code' : 'Repair: write fixed code', layer: 4, verdict: false, children: [],
        comment: S(`${a.label === 'first' ? 'The model writes one HTML file from the prompt.' : 'One repair attempt: the model gets its own file and the problem found, and writes it again.'} ${a.codeSeconds.toFixed(1)} s, reply ${a.replyBytes} bytes, ${a.extracted ? `file ${a.htmlBytes} bytes` : 'NO HTML could be extracted from the reply'}.`),
        lines: [] });
      steps.push({ id: render, label: a.label === 'first' ? 'Render headless' : 'Render the repaired file', layer: 4, verdict: false, children: [],
        comment: S(`${a.items.map((x) => `${x.pass ? 'PASS' : 'FAIL'} ${x.id}: ${x.detail}`).join('. ')}.${a.hint ? ` Vision-model hint (not a verdict): ${a.hint.note}` : ''}`),
        lines: [...(a.screenshot ? [`p:photo ${lit(A(a.screenshot)!)}`] : []), ...measure({ passed: a.passed, failed: a.failed, fps: a.fps })] });
    });
    steps.forEach((s, k) => { s.lines.push(...seqNav(stepIds, k)); nodes.push(s); });
    const diff = i === 0 ? differsBy({ model }, { model }) : differsBy({ model: baseModel }, { model });
    const m = { seconds: r.attempts.reduce((n, a) => n + a.codeSeconds, 0), vram: r.modelVramMiB, ram: r.peakRssMiB, bytes: last?.htmlBytes, passed: last?.passed, failed: last?.failed, fps: last?.fps };
    const first = r.attempts[0];
    const outcome = r.error ? `FAILED: ${r.error}` : first && first.failed === 0 ? 'ran on the first attempt' : r.attempts[1] ? (r.attempts[1].failed === 0 ? 'failed a check first, passed after one repair' : 'still failed a check after one repair') : 'failed a check, no repair recorded';
    add({ id, label: `Three.js: ${model}`, layer: 3, verdict: true, children: stepIds,
      comment: S(`Three.js branch, model ${model} (${o.toolNote}). Differs from the baseline: ${diff}. Outcome: ${outcome}. Final scene: ${costLine(m)}. GPU figure is the size Ollama reports for the loaded model (the model server is not one of this run's own processes); RAM is the peak resident size of the Ollama processes. The picture is the final screenshot; the HTML file is linked and opens in a normal browser tab (it is NOT opened in the viewer: that needs a decision, see roadmap F183.4).`),
      lines: [...(last?.screenshot ? [`p:photo ${lit(A(last.screenshot)!)}`] : []), ...(last?.htmlFile ? [`p:scene-file ${lit(A(last.htmlFile)!)}`] : []), `p:differs-by ${lit(diff)}`, ...measure(m),
        ...(last?.hint ? [`p:vision-hint ${lit(S(last.hint.note))}`] : []), `kmeta:review-verdict ${lit('unreviewed')}`, ...seqNav(threeBranchIds, i)] });
  }

  // Structure nodes
  const imageStep = 'bgn:splat-step-image', splatStep = 'bgn:splat-step-splat';
  const pipes: string[] = [];
  const promptId = 'bgn:prompt';
  if (imgBranchIds.length) { pipes.push('bgn:pipeline-image'); add({ id: 'bgn:pipeline-image', label: 'C. Image generation', layer: 1, verdict: false, children: imgBranchIds,
    comment: S(`prompt → image. One branch per image setting; the baseline is the incumbent model at ${baseImg.size} px and ${baseImg.steps} steps, and every other branch names only what it changes. The same seeds are used on every branch.`), lines: [] }); }
  if (configOrder.length) {
    pipes.push('bgn:pipeline-splat');
    add({ id: 'bgn:pipeline-splat', label: 'A. Splat generation', layer: 1, verdict: false, children: [imageStep, splatStep],
      comment: S(`prompt → image → splat. The image is fixed: ${splatSource ? `the "${baseImg.id}" branch of pipeline C, seed ${splatSource.seed}` : 'see pipeline C'}, so the branches below are a pure comparison of splat settings. The baseline is "${firstSplat.config.id}".`), lines: [] });
    add({ id: imageStep, label: 'Step 1. Image (fixed for every splat branch)', layer: 2, verdict: false,
      comment: S(`The single input image for every splat branch. It is the pipeline C baseline image, seed ${splatSource?.seed}.`),
      lines: [...(splatSource ? [`p:photo ${lit(A(splatSource.file)!)}`] : []), 'hnav:order "1"^^xsd:integer', `hnav:next ${splatStep}`] });
    add({ id: splatStep, label: 'Step 2. Splat, one branch per settings config', layer: 2, verdict: false, children: splatBranchIds,
      comment: S('TripoSplat run once per config on the same image and seed. Compare the pictures and open each splat in the viewer.'),
      lines: ['hnav:order "2"^^xsd:integer', `hnav:prev ${imageStep}`] });
  }
  if (threeBranchIds.length) { pipes.push('bgn:pipeline-three'); add({ id: 'bgn:pipeline-three', label: 'B. Three.js scene generation', layer: 1, verdict: false, children: threeBranchIds,
    comment: S(`prompt → scene code by a local model → headless render → (if it failed) one repair with the error fed back. One branch per model; the baseline is ${baseModel}. Checks per scene: ran with no console errors, canvas not blank, frames per second over 5 s, file size. Any vision-model answer is a hint only.`), lines: [] }); }

  const L: string[] = [
    `## ${o.title ?? 'Reckons.AI — Generation bench review'}`,
    '## GENERATED by scripts/content/bench-review.ts (F183.3) from results.jsonl. Do not hand-edit; re-run `npm run bench:review -- --emit`.',
    '',
    '@prefix rdf:   <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
    '@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .',
    '@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .',
    '@prefix ktype: <urn:kbase:type/> .',
    '@prefix p:     <urn:kbase:predicate/> .',
    '@prefix kmeta: <urn:kbase:meta/> .',
    '@prefix hnav:  <urn:reckons:nav/> .',
    '@prefix bgn:   <urn:reckons:bench/generation/> .',
    '',
    `${promptId} rdf:type ktype:Prompt ;`,
    `    rdfs:label ${lit('Prompt')} ;`,
    `    rdfs:comment ${lit(S(`${prompt}\n\nThe one prompt every pipeline starts from. Measured on this machine's local models: ${o.toolNote}. Branches are qualitative: look, then mark pass, fail or a note in the node panel. Checks and any vision-model hint are evidence for you, not verdicts.`))} ;`,
    '    hnav:order "0"^^xsd:integer ;', '    hnav:layer "0"^^xsd:integer ;',
    `    p:has ${pipes.join(', ')} .`, '',
  ];
  for (const n of nodes) {
    const body = [`rdf:type ktype:Concept`, `rdfs:label ${lit(S(n.label))}`, `rdfs:comment ${lit(n.comment)}`, `hnav:layer "${n.layer}"^^xsd:integer`,
      ...n.lines.filter(Boolean), ...(n.children.length ? [`p:has ${n.children.join(', ')}`] : [])];
    // Pipelines hang off the prompt in the order C, A, B as given; give them an order.
    if (n.layer === 1) body.splice(4, 0, `hnav:order "${pipes.indexOf(n.id) + 1}"^^xsd:integer`);
    L.push(`${n.id} ${body.map((b, i) => (i === 0 ? b : '    ' + b)).join(' ;\n').replace(/^/, '')} .`, '');
  }
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}
