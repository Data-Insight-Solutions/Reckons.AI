// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { assertComparable, imageFidelity, readDataset, scoreViews, validateDataset, type RoomManifest } from '../room-bench-lib';
import { positiveInt } from '../room-bench';

function fixture() {
  const manifest: RoomManifest = { schema: 1, scene: 'reckons-synthetic-room', synthetic: true,
    generatorSha256: 'a'.repeat(64), blender: 'test', seed: 7, frames: 32, samples: 1, width: 16, height: 16, evalEvery: 8 };
  const frames = Array.from({ length: 32 }, (_, i) => ({ file_path: `f_${String(i + 1).padStart(4, '0')}.png`,
    transform_matrix: [[1, 0, 0, i / 100], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] }));
  const camera = { w: 16, h: 16, camera_angle_x: 1 };
  return { manifest, train: { ...camera, frames: frames.filter((_, i) => i % 8 !== 0) }, test: { ...camera, frames: frames.filter((_, i) => i % 8 === 0) } };
}

describe('room benchmark fidelity', () => {
  it('identical images have zero error, infinite PSNR represented by null, and SSIM one', () => {
    const rgb = Uint8Array.from({ length: 16 * 16 * 3 }, (_, i) => i % 256);
    expect(imageFidelity(rgb, rgb, 16, 16)).toEqual({ mse: 0, psnrDb: null, ssim: 1 });
  });
  it('measures a known constant error and includes partial edge windows', () => {
    const a = new Uint8Array(9 * 9 * 3).fill(100), b = new Uint8Array(a.length).fill(110);
    const result = imageFidelity(a, b, 9, 9);
    expect(result.mse).toBe(100);
    expect(result.psnrDb).toBeCloseTo(28.1308, 4);
    expect(result.ssim).toBeGreaterThan(0.99);
    b[b.length - 1] = 255;
    expect(imageFidelity(a, b, 9, 9).mse).toBeGreaterThan(100);
  });
  it('penalizes blur and rejects mismatched pixel data', () => {
    const checker = Uint8Array.from({ length: 16 * 16 * 3 }, (_, i) => ((Math.floor(i / 3) % 16 + Math.floor(i / 48)) % 2) * 255);
    const flat = new Uint8Array(checker.length).fill(128);
    expect(imageFidelity(checker, flat, 16, 16).ssim).toBeLessThan(0.01);
    expect(() => imageFidelity(checker, flat.subarray(3), 16, 16)).toThrow(/dimensions/);
  });
});

describe('benchmark integrity', () => {
  it('requires the complete disjoint fixed split and valid cameras', () => {
    const f = fixture();
    expect(() => validateDataset(f.manifest, f.train, f.test)).not.toThrow();
    f.train.frames.push(f.test.frames[0]);
    expect(() => validateDataset(f.manifest, f.train, f.test)).toThrow(/split|overlapping/);
    f.train.frames.pop(); f.test.frames.pop();
    expect(() => validateDataset(f.manifest, f.train, f.test)).toThrow(/Incomplete/);
  });
  it('rejects path traversal, non-finite poses, and non-synthetic datasets', () => {
    const f = fixture();
    f.test.frames[0].file_path = '../private.png';
    expect(() => validateDataset(f.manifest, f.train, f.test)).toThrow(/Invalid/);
    f.test.frames[0].file_path = 'f_0001.png';
    f.test.frames[0].transform_matrix[0][0] = NaN;
    expect(() => validateDataset(f.manifest, f.train, f.test)).toThrow(/pose/);
    f.manifest.synthetic = false;
    expect(() => validateDataset(f.manifest, f.train, f.test)).toThrow(/synthetic/);
  });
  it('refuses comparisons across datasets or metric versions', () => {
    const a = { datasetSha256: 'a', metric: 'v1' };
    expect(() => assertComparable(a, a)).not.toThrow();
    expect(() => assertComparable(a, { ...a, datasetSha256: 'b' })).toThrow(/Not comparable/);
    expect(() => assertComparable(a, { ...a, metric: 'v2' })).toThrow(/Not comparable/);
  });
  it('fails loudly on missing views and fingerprints changed source pixels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'room-bench-test-'));
    try {
      const f = fixture();
      writeFileSync(join(dir, 'benchmark.json'), JSON.stringify(f.manifest));
      writeFileSync(join(dir, 'transforms_train.json'), JSON.stringify(f.train));
      writeFileSync(join(dir, 'transforms_test.json'), JSON.stringify(f.test));
      for (const frame of [...f.train.frames, ...f.test.frames]) await sharp({ create: { width: 16, height: 16, channels: 3, background: '#777' } }).png().toFile(join(dir, frame.file_path));
      const first = await readDataset(dir);
      const scores = await scoreViews(first, dir, dir);
      expect(scores.views).toHaveLength(4);
      expect(scores.aggregate.mse).toBe(0);
      writeFileSync(join(dir, 'transforms.json'), JSON.stringify(f.train));
      await expect(readDataset(dir)).rejects.toThrow(/Unexpected dataset entry/);
      rmSync(join(dir, 'transforms.json'));
      await sharp({ create: { width: 16, height: 16, channels: 3, background: '#888' } }).png().toFile(join(dir, 'f_0001.png'));
      expect((await readDataset(dir)).sha256).not.toBe(first.sha256);
      rmSync(join(dir, 'f_0001.png'));
      await expect(scoreViews(first, dir, dir)).rejects.toThrow();
      await expect(readDataset(dir)).rejects.toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('bounds resource parameters instead of accepting NaN, zero steps or fractions', () => {
    for (const bad of ['NaN', '0', '3.5', '100001']) expect(() => positiveInt(bad, 'steps', 1, 100000)).toThrow();
    expect(positiveInt('0', 'SH', 0, 3)).toBe(0);
  });
});
