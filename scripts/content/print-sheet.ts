#!/usr/bin/env npx tsx
/**
 * Lay out a two-sided sheet of business cards for printing, and write a receipt (F294.8, kb:derived-output-regenerates).
 *
 *   npm run print:sheet -- --front front.png --back back.png --out sheet.pdf
 *       [--paper letter|a4] [--cols 2 --rows 5] [--card-in 3.5x2] [--bleed-in 0.125] [--dpi 300]
 *   npm run print:sheet -- --front ... --back ... --out sheet.pdf --check     (is the sheet still made from these files?)
 *
 * A port of the Python helper (PIL) that built three sheets on 2026-11-12. It uses sharp, already a dependency, for the
 * pixels, and writes the PDF itself (one full-page image per side, the note in Helvetica): no new dependency and no python.
 *
 * Layout: cards butted with no gutter, centred; a bleed of the card's edge colour (the mean of its four corners) around the
 * block; crop marks outside the bleed; the back page mirrored left to right so it lines up when flipped on the LONG edge.
 * A note on the front page tells the printer to print at 100 percent.
 *
 * The receipt (<out>.receipt.json) records what the sheet was made from: the SHA-256 and size of each input image, the layout,
 * the output's hash and the time. `--check` compares the inputs' hashes with the receipt: exit 0 current, 1 stale (the design
 * changed, rebuild), 2 no receipt. Honest limit: the hash says the image file changed, not that it changed in a way a person
 * would call a design change; and the receipt is written next to the sheet, so deleting it hides the history.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import sharp from 'sharp';

export const PAPERS = { letter: { name: 'US Letter', w: 8.5, h: 11 }, a4: { name: 'A4', w: 8.27, h: 11.69 } } as const;
export type Paper = keyof typeof PAPERS;

export interface SheetOptions { paper: Paper; cols: number; rows: number; cardW: number; cardH: number; bleed: number; dpi: number }
export const DEFAULTS: SheetOptions = { paper: 'letter', cols: 2, rows: 5, cardW: 3.5, cardH: 2, bleed: 0.125, dpi: 300 };

export interface Layout { pw: number; ph: number; cw: number; ch: number; gw: number; gh: number; x0: number; y0: number; bleed: number; cols: number; rows: number }

/** Pixel geometry of the sheet. Throws when the block of cards plus bleed and marks does not fit the paper. */
export function layout(o: SheetOptions): Layout {
  const p = PAPERS[o.paper];
  if (!p) throw new Error('unknown paper: ' + o.paper);
  const pw = Math.round(p.w * o.dpi), ph = Math.round(p.h * o.dpi), cw = Math.round(o.cardW * o.dpi), ch = Math.round(o.cardH * o.dpi);
  const bleed = Math.round(o.bleed * o.dpi), gw = cw * o.cols, gh = ch * o.rows;
  const marks = 60 + 14;
  if (gw + 2 * (bleed + marks) > pw || gh + 2 * (bleed + marks) > ph) throw new Error(`${o.cols}x${o.rows} cards of ${o.cardW}x${o.cardH} in with bleed and crop marks do not fit on ${p.name}`);
  return { pw, ph, cw, ch, gw, gh, x0: Math.floor((pw - gw) / 2), y0: Math.floor((ph - gh) / 2), bleed, cols: o.cols, rows: o.rows };
}

type Rgb = [number, number, number];
/** The mean colour of the four corners (2 px in), which the bleed is filled with. */
export function edgeColour(raw: Buffer, w: number, h: number): Rgb {
  const at = (x: number, y: number): Rgb => { const i = (y * w + x) * 3; return [raw[i], raw[i + 1], raw[i + 2]]; };
  const px = [at(2, 2), at(w - 3, 2), at(2, h - 3), at(w - 3, h - 3)];
  return [0, 1, 2].map((k) => Math.floor(px.reduce((a, c) => a + c[k], 0) / 4)) as Rgb;
}

/** SVG of the bleed block and the crop marks (rects only, no fonts). */
export function overlaySvg(l: Layout, edge: Rgb): { under: string; marks: string } {
  const m = 60, g = 14, ink = 'rgb(90,90,90)';
  const under = `<svg xmlns="http://www.w3.org/2000/svg" width="${l.pw}" height="${l.ph}"><rect x="${l.x0 - l.bleed}" y="${l.y0 - l.bleed}" width="${l.gw + 2 * l.bleed}" height="${l.gh + 2 * l.bleed}" fill="rgb(${edge.join(',')})"/></svg>`;
  const r: string[] = [];
  for (let c = 0; c <= l.cols; c++) { const x = l.x0 + c * l.cw; r.push(`<rect x="${x - 1}" y="${l.y0 - l.bleed - g - m}" width="2" height="${m}"/>`, `<rect x="${x - 1}" y="${l.y0 + l.gh + l.bleed + g}" width="2" height="${m}"/>`); }
  for (let k = 0; k <= l.rows; k++) { const y = l.y0 + k * l.ch; r.push(`<rect x="${l.x0 - l.bleed - g - m}" y="${y - 1}" width="${m}" height="2"/>`, `<rect x="${l.x0 + l.gw + l.bleed + g}" y="${y - 1}" width="${m}" height="2"/>`); }
  return { under, marks: `<svg xmlns="http://www.w3.org/2000/svg" width="${l.pw}" height="${l.ph}"><g fill="${ink}">${r.join('')}</g></svg>` };
}

/** One page as raw RGB: white, the bleed block, the cards (the back mirrored), the crop marks. */
export async function renderPage(card: Buffer, l: Layout, mirror: boolean): Promise<{ raw: Buffer; edge: Rgb }> {
  const edge = edgeColour(card, l.cw, l.ch);
  const { under, marks } = overlaySvg(l, edge);
  const tiles = [];
  for (let r = 0; r < l.rows; r++) for (let c = 0; c < l.cols; c++) tiles.push({ input: card, raw: { width: l.cw, height: l.ch, channels: 3 as const }, left: l.x0 + (mirror ? l.cols - 1 - c : c) * l.cw, top: l.y0 + r * l.ch });
  const raw = await sharp({ create: { width: l.pw, height: l.ph, channels: 3, background: '#ffffff' } })
    .composite([{ input: Buffer.from(under), left: 0, top: 0 }, ...tiles, { input: Buffer.from(marks), left: 0, top: 0 }])
    .removeAlpha().raw().toBuffer();
  return { raw, edge };
}

const pdfEsc = (s: string): string => s.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7e]/g, '?');

/** A minimal PDF: each page is one full-page RGB image (Flate) and, optionally, one line of Helvetica text. */
export function pdfFromPages(pages: { raw: Buffer; w: number; h: number; note?: string; noteX?: number }[], dpi: number): Buffer {
  const objs: Buffer[] = [];
  const add = (b: string | Buffer): number => { objs.push(Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1')); return objs.length; };
  add(''); add(''); // 1 catalog, 2 pages: filled in below
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const p of pages) {
    const wpt = (p.w * 72) / dpi, hpt = (p.h * 72) / dpi;
    const data = deflateSync(p.raw);
    const img = add(Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`, 'latin1'), data, Buffer.from('\nendstream', 'latin1')]));
    const text = p.note ? `BT /F1 7 Tf 0.43 g ${((p.noteX ?? 90) * 72) / dpi} ${hpt - 14} Td (${pdfEsc(p.note)}) Tj ET\n` : '';
    const body = `q ${wpt} 0 0 ${hpt} 0 0 cm /Im0 Do Q\n${text}`;
    const content = add(`<< /Length ${body.length} >>\nstream\n${body}endstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${wpt} ${hpt}] /Resources << /XObject << /Im0 ${img} 0 R >> /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[0] = Buffer.from('<< /Type /Catalog /Pages 2 0 R >>');
  objs[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`);
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  const offsets: number[] = [];
  let pos = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(pos);
    const b = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(b); pos += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  parts.push(Buffer.from(xref + `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return Buffer.concat(parts);
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
export interface Receipt {
  tool: string; builtAt: string; layout: SheetOptions & { paperName: string; pagePx: [number, number]; cardPx: [number, number] };
  inputs: { front: { file: string; sha256: string; bytes: number; width: number; height: number }; back: { file: string; sha256: string; bytes: number; width: number; height: number } };
  edgeColours: { front: Rgb; back: Rgb }; output: { file: string; sha256: string; bytes: number; pages: number };
}

async function inputInfo(file: string) {
  const buf = readFileSync(file);
  const m = await sharp(buf).metadata();
  return { buf, info: { file, sha256: sha(buf), bytes: buf.length, width: m.width ?? 0, height: m.height ?? 0 } };
}

/** Builds the sheet and its receipt. `now` is injectable so a test can pin the time. */
export async function buildSheet(frontFile: string, backFile: string, outFile: string, o: SheetOptions = DEFAULTS, now: () => Date = () => new Date()): Promise<Receipt> {
  const l = layout(o);
  const [f, b] = await Promise.all([inputInfo(frontFile), inputInfo(backFile)]);
  const fit = (buf: Buffer) => sharp(buf).removeAlpha().toColourspace('srgb').resize(l.cw, l.ch, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer();
  const [fr, bk] = await Promise.all([fit(f.buf), fit(b.buf)]);
  const [pf, pb] = await Promise.all([renderPage(fr, l, false), renderPage(bk, l, true)]);
  const cards = l.cols * l.rows;
  const note = `Front. Print at 100% / Actual size, two-sided, flip on LONG edge. ${cards} cards, ${o.cardW} x ${o.cardH} in. Cut on the marks.`;
  const pdf = pdfFromPages([{ raw: pf.raw, w: l.pw, h: l.ph, note, noteX: l.x0 + 90 }, { raw: pb.raw, w: l.pw, h: l.ph, note: 'Back', noteX: l.x0 + 90 }], o.dpi);
  writeFileSync(outFile, pdf);
  const receipt: Receipt = {
    tool: 'scripts/content/print-sheet.ts', builtAt: now().toISOString(),
    layout: { ...o, paperName: PAPERS[o.paper].name, pagePx: [l.pw, l.ph], cardPx: [l.cw, l.ch] },
    inputs: { front: f.info, back: b.info }, edgeColours: { front: pf.edge, back: pb.edge },
    output: { file: outFile, sha256: sha(pdf), bytes: pdf.length, pages: 2 },
  };
  writeFileSync(receiptPath(outFile), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

export const receiptPath = (out: string): string => out.replace(/\.pdf$/i, '') + '.receipt.json';

/** 'current' when both inputs still hash as the receipt says; 'stale' with the names of those that changed; 'no-receipt'. */
export function checkReceipt(frontFile: string, backFile: string, outFile: string): { state: 'current' | 'stale' | 'no-receipt'; changed: string[] } {
  const rp = receiptPath(outFile);
  if (!existsSync(rp) || !existsSync(outFile)) return { state: 'no-receipt', changed: [] };
  const r = JSON.parse(readFileSync(rp, 'utf8')) as Receipt;
  const changed: string[] = [];
  if (sha(readFileSync(frontFile)) !== r.inputs.front.sha256) changed.push('front');
  if (sha(readFileSync(backFile)) !== r.inputs.back.sha256) changed.push('back');
  if (sha(readFileSync(outFile)) !== r.output.sha256) changed.push('the sheet itself');
  return { state: changed.length ? 'stale' : 'current', changed };
}

export function parseArgs(argv: string[]): { front?: string; back?: string; out?: string; check: boolean; opts: SheetOptions } {
  const get = (n: string): string | undefined => { const i = argv.indexOf('--' + n); if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]; return argv.find((a) => a.startsWith('--' + n + '='))?.split('=').slice(1).join('='); };
  const num = (n: string, d: number): number => { const v = get(n); if (v === undefined) return d; const x = Number(v); if (!Number.isFinite(x) || x <= 0) throw new Error('--' + n + ' must be a positive number'); return x; };
  const paper = (get('paper') ?? DEFAULTS.paper) as Paper;
  if (!(paper in PAPERS)) throw new Error('--paper must be letter or a4');
  let cardW = DEFAULTS.cardW, cardH = DEFAULTS.cardH;
  const ci = get('card-in');
  if (ci) { const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)$/.exec(ci); if (!m) throw new Error('--card-in must look like 3.5x2'); cardW = Number(m[1]); cardH = Number(m[2]); }
  return { front: get('front'), back: get('back'), out: get('out'), check: argv.includes('--check'), opts: { paper, cols: Math.round(num('cols', DEFAULTS.cols)), rows: Math.round(num('rows', DEFAULTS.rows)), cardW, cardH, bleed: get('bleed-in') === undefined ? DEFAULTS.bleed : num('bleed-in', 0), dpi: num('dpi', DEFAULTS.dpi) } };
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.front || !a.back || !a.out) { console.error('Usage: npm run print:sheet -- --front f.png --back b.png --out sheet.pdf [--paper letter|a4] [--cols 2 --rows 5] [--card-in 3.5x2] [--bleed-in 0.125] [--check]'); process.exit(2); }
  if (a.check) {
    const c = checkReceipt(a.front, a.back, a.out);
    console.log(c.state === 'current' ? 'print-sheet --check: current' : c.state === 'stale' ? 'print-sheet --check: STALE, changed since the sheet was built: ' + c.changed.join(', ') : 'print-sheet --check: no sheet or receipt to compare');
    process.exit(c.state === 'current' ? 0 : c.state === 'stale' ? 1 : 2);
  }
  const r = await buildSheet(a.front, a.back, a.out, a.opts);
  console.log(`${a.out}: ${r.output.pages} pages, ${r.output.bytes} bytes; receipt ${receiptPath(a.out)}`);
}

if (process.argv[1] && process.argv[1].endsWith('print-sheet.ts')) main().catch((e) => { console.error(String(e instanceof Error ? e.message : e)); process.exit(1); });
