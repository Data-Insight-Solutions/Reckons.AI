import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { judgeSplatPly, type SplatCheck } from '../../../src/lib/3d/splat-check';
import { buildRoom } from '../synthetic-room';
import { compressSplat, decodeToPly, judgeCompressed, verifyCompressed } from '../splat-compress';

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
  writeFileSync(ply, buildRoom().bytes);

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
