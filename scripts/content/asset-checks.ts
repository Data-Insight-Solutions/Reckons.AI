/**
 * Acceptance checks for generated assets (F58.9.1 / kb:splat-local-pipeline; PDF and SVG added for the
 * asset QA loop, F281.1).
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
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { sampleFrames, meanAbsDiff } from '../../tests/visual/vision-frames';

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

// Frame reads run on the shared sampler (tests/visual/vision-frames.ts, F93.1): the same 64x64
// greyscale frames, but one that also serves the visual suite, so the two can never drift apart in
// what a frame at a named time is. The numbers must stay identical to the old select=eq(n,…) reads
// (pinned in tests/visual/vision-frames.test.ts: carved-turtle 0.2061, lighthouse-island 0.0543).
export function checkVideo(file: string, expect?: { frames?: number }): Check {
  try {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,nb_read_frames:format=duration', '-of', 'json', file], { encoding: 'utf8' }));
    const st = probe.streams?.[0] ?? {};
    const frames = Number(st.nb_read_frames ?? 0);
    const durationS = Number(probe.format?.duration ?? 0);
    // 0 and the duration: the duration lands in the gap after the last frame's timestamp, and the
    // sampler's clamp re-seeks to the last frame — the same two frames the old first/last reads took.
    const [first, last] = sampleFrames(file, [0, Math.round(durationS * 1000)], { width: 64, height: 64 });
    const motion = meanAbsDiff(first, last);
    return judgeVideo({ width: Number(st.width ?? 0), height: Number(st.height ?? 0), frames, durationS, motion }, expect);
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

// ── PDF (F281.1) ─────────────────────────────────────────────────────────────
// A page generator also exits 0 on a broken page: an empty page, a font the printer will swap, a
// slot whose text ran off the edge, the partner's name missing. These are read with poppler's
// command-line tools (pdfinfo, pdffonts, pdftotext, pdftoppm), so no PDF library is loaded.

export interface PdfStats {
  pages: number;
  /** Width x height in points, per page. */
  pageSizesPt: [number, number][];
  fontsNotEmbedded: string[];
  fontCount: number;
  /** All extractable text, pages joined. */
  text: string;
  /** Words whose box lies partly outside their page. */
  wordsOutside: number;
  /** Largest channel standard deviation of each page rendered small; a white page is about 0. */
  pageSpread: number[];
}

export interface PdfExpect { pages?: number; pageSizePt?: [number, number]; text?: string[] }

/** Below this spread a rendered page is, to the eye, empty. A page with one short line of 10 pt text measures well above it at 24 dpi. */
export const BLANK_PAGE_SPREAD = 1.5;

const squash = (t: string): string => t.toLowerCase().replace(/\s+/g, ' ').trim();

export function judgePdf(s: PdfStats, expect: PdfExpect = {}): Check {
  const problems: string[] = [];
  const notes: string[] = [];
  if (s.pages < 1) problems.push('no pages');
  if (expect.pages !== undefined && s.pages !== expect.pages) problems.push(`${s.pages} page(s), expected ${expect.pages}`);
  if (expect.pageSizePt) {
    const [w, h] = expect.pageSizePt;
    s.pageSizesPt.forEach(([pw, ph], i) => {
      if (Math.abs(pw - w) > 1 || Math.abs(ph - h) > 1) problems.push(`page ${i + 1} is ${pw.toFixed(0)}x${ph.toFixed(0)} pt, expected ${w.toFixed(0)}x${h.toFixed(0)}`);
    });
  }
  if (s.fontsNotEmbedded.length) problems.push(`fonts not embedded (another machine or a printer substitutes them): ${s.fontsNotEmbedded.join(', ')}`);
  s.pageSpread.forEach((v, i) => { if (!(v >= BLANK_PAGE_SPREAD)) problems.push(`page ${i + 1} is blank`); });
  if (s.wordsOutside > 0) problems.push(`${s.wordsOutside} word(s) run off the page`);
  const have = squash(s.text);
  for (const phrase of expect.text ?? []) if (!have.includes(squash(phrase))) problems.push(`expected text missing: "${phrase}"`);
  if (!have) notes.push('no extractable text: an image-only PDF cannot be searched, copied or read aloud');
  return {
    pass: problems.length === 0, problems, notes,
    measured: { pages: s.pages, fonts: s.fontCount, fontsNotEmbedded: s.fontsNotEmbedded.length, words: have ? have.split(' ').length : 0, wordsOutside: s.wordsOutside,
      minPageSpread: s.pageSpread.length ? Number(Math.min(...s.pageSpread).toFixed(2)) : 0 },
  };
}

/** `pdfinfo -f 1 -l N` page-size lines -> [w, h] in points. Pure. */
export function parsePdfPageSizes(info: string): [number, number][] {
  return [...info.matchAll(/^Page\s+\d+\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/gm)].map((m) => [Number(m[1]), Number(m[2])]);
}

/** `pdffonts` table -> font names whose emb column is "no". The last five columns are emb, sub, uni and a two-part object id. Pure. */
export function parsePdfFonts(table: string): { count: number; notEmbedded: string[] } {
  const rows = table.split('\n').slice(2).map((l) => l.trim()).filter(Boolean);
  const notEmbedded: string[] = [];
  for (const r of rows) {
    const t = r.split(/\s+/);
    if (t.length >= 6 && t[t.length - 5] === 'no') notEmbedded.push(t[0]);
  }
  return { count: rows.length, notEmbedded };
}

/** `pdftotext -bbox` XHTML -> words with a box outside their page (0.5 pt tolerance). Pure. */
export function countWordsOutside(bbox: string): number {
  let outside = 0;
  for (const page of bbox.split('<page ').slice(1)) {
    const w = Number(/width="([\d.]+)"/.exec(page)?.[1]);
    const h = Number(/height="([\d.]+)"/.exec(page)?.[1]);
    if (!(w > 0 && h > 0)) continue;
    for (const m of page.matchAll(/<word xMin="([-\d.]+)" yMin="([-\d.]+)" xMax="([-\d.]+)" yMax="([-\d.]+)"/g)) {
      const [x0, y0, x1, y1] = m.slice(1, 5).map(Number);
      if (x0 < -0.5 || y0 < -0.5 || x1 > w + 0.5 || y1 > h + 0.5) outside++;
    }
  }
  return outside;
}

const run = (cmd: string, args: string[]): string => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });

/** Renders each page small (24 dpi) into a private temporary folder, measures it, and removes the folder. */
export async function renderPdfPages(file: string, dpi = 24, maxPages = 50): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), 'asset-qa-pdf-'));
  run('pdftoppm', ['-r', String(dpi), '-l', String(maxPages), '-png', file, join(dir, 'p')]);
  return readdirSync(dir).filter((f) => f.endsWith('.png')).sort().map((f) => join(dir, f));
}

export async function readPdfStats(file: string): Promise<PdfStats> {
  const pagesLine = /^Pages:\s+(\d+)/m.exec(run('pdfinfo', [file]));
  const pages = pagesLine ? Number(pagesLine[1]) : 0;
  const sizes = pages ? parsePdfPageSizes(run('pdfinfo', ['-f', '1', '-l', String(pages), file])) : [];
  const fonts = parsePdfFonts(run('pdffonts', [file]));
  const text = run('pdftotext', ['-layout', file, '-']);
  const wordsOutside = countWordsOutside(run('pdftotext', ['-bbox', file, '-']));
  const pngs = pages ? await renderPdfPages(file) : [];
  const pageSpread: number[] = [];
  try {
    for (const png of pngs) pageSpread.push(Math.max(...(await sharp(png).stats()).channels.slice(0, 3).map((c) => c.stdev)));
  } finally { if (pngs.length) rmSync(join(pngs[0], '..'), { recursive: true, force: true }); }
  return { pages, pageSizesPt: sizes, fontsNotEmbedded: fonts.notEmbedded, fontCount: fonts.count, text, wordsOutside, pageSpread };
}

export async function checkPdf(file: string, expect: PdfExpect = {}): Promise<Check> {
  try { return judgePdf(await readPdfStats(file), expect); }
  catch (e) { return { pass: false, problems: [`not a readable PDF: ${(e as Error).message.split('\n')[0]}`], notes: [], measured: {} }; }
}

// ── SVG (F281.1) ─────────────────────────────────────────────────────────────

/** Source-level rules for a generated SVG. Script or an external reference makes it unsafe or offline-broken. Pure. */
export function judgeSvgSource(src: string): Check {
  const problems: string[] = [];
  if (!/<svg[\s>]/i.test(src)) problems.push('no <svg> root');
  else if (!/<svg[^>]*\bviewBox=/i.test(src) && !(/<svg[^>]*\bwidth=/i.test(src) && /<svg[^>]*\bheight=/i.test(src))) problems.push('no viewBox or width and height, so its size is undefined');
  if (/<script[\s>]|\son\w+\s*=/i.test(src)) problems.push('contains script or an event handler');
  const external = [...src.matchAll(/(?:xlink:)?href\s*=\s*["'](https?:[^"']+)/gi)].map((m) => m[1]);
  if (external.length) problems.push(`external reference(s), which break offline and in print: ${external.slice(0, 3).join(', ')}`);
  return { pass: problems.length === 0, problems, notes: [], measured: { bytes: src.length } };
}

/** Rasterises an SVG with sharp's built-in librsvg (no Inkscape needed). */
export async function renderSvg(file: string, width = 512): Promise<Buffer> {
  return sharp(readFileSync(file)).resize({ width }).flatten({ background: '#ffffff' }).png().toBuffer();
}

export async function checkSvg(file: string): Promise<Check> {
  let src: string;
  try { src = readFileSync(file, 'utf8'); } catch (e) { return { pass: false, problems: [`unreadable: ${(e as Error).message}`], notes: [], measured: {} }; }
  const source = judgeSvgSource(src);
  if (!source.pass) return source;
  try {
    const png = await renderSvg(file);
    const img = sharp(png);
    const meta = await img.metadata();
    const r = judgeImage({ width: meta.width ?? 0, height: meta.height ?? 0, channelStdev: (await img.stats()).channels.map((c) => c.stdev) });
    return { ...r, problems: r.problems.map((p) => p.replace(/^flat image/, 'renders flat')), measured: { ...source.measured, ...r.measured } };
  } catch (e) {
    return { pass: false, problems: [`does not render: ${(e as Error).message.split('\n')[0]}`], notes: [], measured: source.measured };
  }
}

/** Dispatch on extension. */
export async function checkAsset(file: string, expect: PdfExpect = {}): Promise<Check> {
  if (/\.(png|webp|jpe?g)$/i.test(file)) return checkImage(file);
  if (/\.(webm|mp4)$/i.test(file)) return checkVideo(file);
  if (/\.ply$/i.test(file)) return checkSplat(file);
  if (/\.pdf$/i.test(file)) return checkPdf(file, expect);
  if (/\.svg$/i.test(file)) return checkSvg(file);
  return { pass: false, problems: [`no check for ${file}`], notes: [], measured: {} };
}
