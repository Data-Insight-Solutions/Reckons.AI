import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildSheet, checkReceipt, DEFAULTS, edgeColour, layout, parseArgs, receiptPath, renderPage } from '../print-sheet';

// Synthetic cards only: a flat colour with a block, never the real card.
const dir = mkdtempSync(join(tmpdir(), 'print-sheet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const card = (bg: string, block: string) => sharp({ create: { width: 700, height: 400, channels: 3, background: bg } })
  .composite([{ input: { create: { width: 100, height: 100, channels: 3, background: block } }, left: 20, top: 20 }]).png().toBuffer();

describe('print-sheet layout', () => {
  it('centres a 2x5 grid of 3.5x2 in cards on US Letter at 300 dpi', () => {
    const l = layout(DEFAULTS);
    expect([l.pw, l.ph, l.cw, l.ch, l.gw, l.gh]).toEqual([2550, 3300, 1050, 600, 2100, 3000]);
    expect([l.x0, l.y0, l.bleed]).toEqual([225, 150, 38]);
  });
  it('A4 is a different page, and a grid that does not fit is refused', () => {
    expect(layout({ ...DEFAULTS, paper: 'a4' }).pw).toBe(2481);
    expect(() => layout({ ...DEFAULTS, cols: 3 })).toThrow(/do not fit/);
  });
  it('reads options from the command line and refuses nonsense', () => {
    const a = parseArgs(['--front', 'a.png', '--back=b.png', '--out', 'o.pdf', '--paper', 'a4', '--cols', '2', '--rows', '4', '--card-in', '3.5x2', '--bleed-in', '0.1', '--check']);
    expect(a).toMatchObject({ front: 'a.png', back: 'b.png', out: 'o.pdf', check: true, opts: { paper: 'a4', rows: 4, bleed: 0.1 } });
    expect(() => parseArgs(['--paper', 'tabloid'])).toThrow();
    expect(() => parseArgs(['--card-in', 'big'])).toThrow();
    expect(() => parseArgs(['--cols', '0'])).toThrow();
  });
});

describe('print-sheet pages', () => {
  it('the edge colour is the mean of the four corners, and the bleed is painted in it', async () => {
    const l = layout({ ...DEFAULTS, cardW: 2, cardH: 1, cols: 2, rows: 2, dpi: 100 });
    const raw = await sharp(await card('#102030', '#ffffff')).resize(l.cw, l.ch, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    expect(edgeColour(raw, l.cw, l.ch)).toEqual([16, 32, 48]);
    const page = await renderPage(raw, l, false);
    const px = (x: number, y: number) => [...page.raw.subarray((y * l.pw + x) * 3, (y * l.pw + x) * 3 + 3)];
    expect(px(l.x0 - 2, l.y0 + 5)).toEqual([16, 32, 48]); // inside the bleed
    expect(px(2, 2)).toEqual([255, 255, 255]); // paper
  });
  it('crop marks stand outside the bleed at each card edge, and the grid is not drawn over the cards', async () => {
    const l = layout({ ...DEFAULTS, cardW: 2, cardH: 1, cols: 2, rows: 2, dpi: 100 });
    const raw = await sharp(await card('#102030', '#ffffff')).resize(l.cw, l.ch, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    const page = (await renderPage(raw, l, true)).raw;
    const px = (x: number, y: number) => page[(y * l.pw + x) * 3];
    expect(px(l.x0 + l.cw, l.y0 - l.bleed - 14 - 30)).toBe(90); // a vertical mark above the block
    expect(px(l.x0 - l.bleed - 14 - 30, l.y0 + l.ch)).toBe(90); // a horizontal mark left of the block
    expect(px(l.x0 + l.cw, l.y0 + 20)).not.toBe(90); // nothing drawn on the card itself
  });
});

describe('print-sheet receipt', () => {
  it('writes a two-page PDF and a receipt, and --check tells current from stale', async () => {
    const f = join(dir, 'f.png'), b = join(dir, 'b.png'), out = join(dir, 's.pdf');
    writeFileSync(f, await card('#102030', '#ffffff')); writeFileSync(b, await card('#203040', '#00ff00'));
    const r = await buildSheet(f, b, out, { ...DEFAULTS, cardW: 2, cardH: 1, cols: 2, rows: 3, dpi: 100 }, () => new Date('2026-11-12T12:00:00Z'));
    const pdf = readFileSync(out, 'latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toMatch(/\/Count 2/);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(r.builtAt).toBe('2026-11-12T12:00:00.000Z');
    expect(r.inputs.front.width).toBe(700);
    expect(r.layout.cardPx).toEqual([200, 100]);
    expect(JSON.parse(readFileSync(receiptPath(out), 'utf8')).inputs.back.sha256).toBe(r.inputs.back.sha256);
    expect(checkReceipt(f, b, out)).toEqual({ state: 'current', changed: [] });
    writeFileSync(b, await card('#203040', '#00ff01')); // the design changed
    expect(checkReceipt(f, b, out)).toEqual({ state: 'stale', changed: ['back'] });
    expect(checkReceipt(f, b, join(dir, 'none.pdf')).state).toBe('no-receipt');
  });
});
