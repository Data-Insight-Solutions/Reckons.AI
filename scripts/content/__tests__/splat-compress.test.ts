import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { judgeSplatPly, type SplatCheck } from '../../../src/lib/3d/splat-check';
import { plyCentres } from '../../../src/lib/3d/splat-check';
import { compressSplat, cropPly, decodeToPly, judgeCompressed, toolBox, verifyCompressed } from '../splat-compress';

/** A deterministic PLY of `n` Gaussians scattered in a 5 x 2.6 x 4 slab (synthetic; nothing real). */
function slabPly(n: number): Uint8Array {
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
  const body = new Float32Array(n * props.length);
  let a = 12345;
  const rnd = () => { a = (a * 1664525 + 1013904223) >>> 0; return a / 4294967296; };
  for (let i = 0; i < n; i++) body.set([(rnd() - 0.5) * 5, rnd() * 2.6, (rnd() - 0.5) * 4, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, 2, -4, -4, -4, 1, 0, 0, 0], i * props.length);
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(new TextEncoder().encode(head));
  out.set(new Uint8Array(body.buffer), head.length);
  return out;
}

const ok = (count: number, extent: number): SplatCheck => ({ pass: true, problems: [], notes: [], measured: { count, extent } });

describe('judgeCompressed (pure)', () => {
  it('passes the same count and an extent within 2%', () => { expect(judgeCompressed(ok(100, 5), ok(100, 5.05)).pass).toBe(true); });
  it('fails when Gaussians were lost', () => { expect(judgeCompressed(ok(100, 5), ok(99, 5)).problems.join()).toMatch(/99 Gaussians after compression, 100 before/); });
  it('fails when the room changed size', () => { expect(judgeCompressed(ok(100, 5), ok(100, 6)).problems.join()).toMatch(/more than 2% apart/); });
  it('fails when the compressed file does not decode', () => {
    const bad: SplatCheck = { pass: false, problems: ['no Gaussians'], notes: [], measured: {} };
    expect(judgeCompressed(ok(100, 5), bad).problems.join()).toMatch(/does not decode/);
  });
});

// Real conversions through splat-transform, on the small deterministic synthetic room. CPU only.
describe('compressSplat (real converter, synthetic room)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'splat-compress-test-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const ply = join(dir, 'room.ply');
  writeFileSync(ply, slabPly(9000));

  it('refuses SOG without a GPU named, instead of running for hours on the CPU', () => {
    const was = process.env.RECKONS_SPLAT_GPU;
    delete process.env.RECKONS_SPLAT_GPU;
    try { expect(() => compressSplat(ply, { format: 'sog' })).toThrow(/needs a GPU/); } finally { if (was !== undefined) process.env.RECKONS_SPLAT_GPU = was; }
  });

  // SOG is GPU work: it is exercised only when RECKONS_SPLAT_GPU names an adapter (it did on 2026-10-14, adapter 1).
  for (const format of (process.env.RECKONS_SPLAT_GPU ? ['spz', 'sog'] : ['spz']) as ('spz' | 'sog')[]) {
    it(`${format}: smaller, same count, extent kept, recorded as lossy, and re-verifiable`, () => {
      const r = compressSplat(ply, { format });
      expect(r.check.pass, r.check.problems.join()).toBe(true);
      expect(r.lossy).toBe(true);
      expect(r.ratio).toBeGreaterThan(2);
      expect(r.gaussians).toBe(r.source.gaussians);
      expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(verifyCompressed(dir, r)).toEqual([]);
      const back = judgeSplatPly(decodeToPly(join(dir, r.file)));
      expect(back.pass).toBe(true);
    }, 60_000);
  }

  it('a tampered compressed file is caught by the receipt hash', () => {
    const r = compressSplat(ply, { format: 'spz' });
    writeFileSync(join(dir, r.file), Buffer.from('garbage'));
    expect(verifyCompressed(dir, r).length).toBeGreaterThan(0);
  });

  it('refuses a file that is not a splat', () => {
    const junk = join(dir, 'junk.ply');
    writeFileSync(junk, 'not a ply');
    expect(() => compressSplat(junk)).toThrow(/not a usable splat/);
  });
});

// F58.9.6.1: the crop box is in FILE coordinates. splat-transform applies it with x and y mirrored, which used to
// keep the mirror-image region and cut off any object that sat away from the origin.
describe('cropPly keeps the region it was asked for', () => {
  it('mirrors x and y for the tool and leaves z alone', () => {
    expect(toolBox({ min: [1, 2, 3], max: [4, 5, 6] })).toEqual({ min: [-4, -5, 3], max: [-1, -2, 6] });
  });
  it('keeps Gaussians inside the box in file coordinates and drops the mirror image (real converter, synthetic points)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crop-test-'));
    try {
      const ply = join(dir, 'in.ply');
      writeFileSync(ply, slabPly(4000));
      const box = { min: [0.5, 0.2, -1], max: [2.4, 1.8, 1] };
      cropPly(ply, join(dir, 'out.ply'), box);
      const c = await plyCentres(new Uint8Array(readFileSync(join(dir, 'out.ply'))), 100000);
      expect(c.length).toBeGreaterThan(0);
      for (let i = 0; i < c.length; i += 3) {
        expect(c[i]).toBeGreaterThanOrEqual(0.5 - 1e-4); expect(c[i]).toBeLessThanOrEqual(2.4 + 1e-4);
        expect(c[i + 1]).toBeGreaterThanOrEqual(0.2 - 1e-4); expect(c[i + 1]).toBeLessThanOrEqual(1.8 + 1e-4);
        expect(c[i + 2]).toBeGreaterThanOrEqual(-1 - 1e-4); expect(c[i + 2]).toBeLessThanOrEqual(1 + 1e-4);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
