/**
 * The acceptance checks for generated assets (F58.9.1). Each check is shown the failure it
 * exists to catch — a flat image, a still or one-frame clip, a truncated or NaN-filled splat — as
 * well as a good file, because a guard that has never seen the bad case is not a guard.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { judgeImage, judgeVideo, judgeSplatPly, checkImage, REQUIRED_SPLAT_PROPS, LOW_MOTION } from '../asset-checks';

/** A synthetic 3DGS PLY: `n` Gaussians on a line, with the 14 required float properties. */
function makePly(n: number, opts: { nan?: boolean; opacity?: number; truncate?: number; drop?: string; spread?: number } = {}): Uint8Array {
  const props = REQUIRED_SPLAT_PROPS.filter((p) => p !== opts.drop);
  const header = ['ply', 'format binary_little_endian 1.0', `element vertex ${n}`, ...props.map((p) => `property float ${p}`), 'end_header', ''].join('\n');
  const head = new TextEncoder().encode(header);
  const body = new DataView(new ArrayBuffer(n * props.length * 4));
  for (let i = 0; i < n; i++) {
    props.forEach((p, k) => {
      let v = 0;
      if (p === 'x') v = (i / n) * (opts.spread ?? 1);
      if (p === 'opacity') v = opts.opacity ?? 2; // logit 2 ≈ 0.88 visible
      if (p === 'rot_0') v = 1;
      if (opts.nan && i === 3 && p === 'scale_0') v = NaN;
      body.setFloat32((i * props.length + k) * 4, v, true);
    });
  }
  const bytes = new Uint8Array(head.length + body.byteLength);
  bytes.set(head, 0);
  bytes.set(new Uint8Array(body.buffer), head.length);
  return opts.truncate ? bytes.subarray(0, bytes.length - opts.truncate) : bytes;
}

describe('judgeSplatPly', () => {
  it('accepts a well-formed splat and measures it', () => {
    const c = judgeSplatPly(makePly(64), { count: 64 });
    expect(c.pass).toBe(true);
    expect(c.measured).toMatchObject({ count: 64, bytesPerGaussian: 56, visibleFraction: 1 });
  });
  it('rejects a truncated file', () => {
    expect(judgeSplatPly(makePly(64, { truncate: 10 })).problems.join()).toMatch(/truncated/);
  });
  it('rejects non-finite values', () => {
    expect(judgeSplatPly(makePly(64, { nan: true })).problems.join()).toMatch(/non-finite/);
  });
  it('rejects a splat whose Gaussians are all transparent', () => {
    expect(judgeSplatPly(makePly(64, { opacity: -20 })).problems.join()).toMatch(/visible/);
  });
  it('rejects a splat collapsed to a point', () => {
    expect(judgeSplatPly(makePly(64, { spread: 0 })).problems.join()).toMatch(/degenerate/);
  });
  it('rejects a layout missing a required property', () => {
    expect(judgeSplatPly(makePly(8, { drop: 'opacity' })).problems.join()).toMatch(/missing properties: opacity/);
  });
  it('rejects the wrong count and non-PLY bytes', () => {
    expect(judgeSplatPly(makePly(64), { count: 32 }).pass).toBe(false);
    expect(judgeSplatPly(new TextEncoder().encode('hello')).pass).toBe(false);
  });
});

describe('judgeVideo', () => {
  const ok = { width: 512, height: 512, frames: 49, durationS: 3, motion: 0.08 };
  it('accepts a moving clip', () => {
    const c = judgeVideo(ok, { frames: 49 });
    expect(c.pass).toBe(true);
    expect(c.notes).toEqual([]);
  });
  it('passes a nearly still clip but says so, rather than calling it fine', () => {
    const c = judgeVideo({ ...ok, motion: LOW_MOTION / 2 });
    expect(c.pass).toBe(true);
    expect(c.notes.join()).toMatch(/low motion/);
  });
  it('rejects one frame, the wrong frame count and no duration', () => {
    expect(judgeVideo({ ...ok, frames: 1 }).pass).toBe(false);
    expect(judgeVideo(ok, { frames: 33 }).pass).toBe(false);
    expect(judgeVideo({ ...ok, durationS: 0 }).pass).toBe(false);
  });
});

describe('judgeImage / checkImage', () => {
  it('rejects a flat image and accepts a varied one', () => {
    expect(judgeImage({ width: 768, height: 768, channelStdev: [0.5, 0.4, 0.3] }).problems.join()).toMatch(/flat/);
    expect(judgeImage({ width: 768, height: 768, channelStdev: [30, 20, 10] }).pass).toBe(true);
    expect(judgeImage({ width: 32, height: 32, channelStdev: [30, 20, 10] }).pass).toBe(false);
  });
  it('decodes real WebP files: a grey square fails, a gradient passes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asset-checks-'));
    const flat = join(dir, 'flat.webp');
    await sharp({ create: { width: 128, height: 128, channels: 3, background: { r: 128, g: 128, b: 128 } } }).webp().toFile(flat);
    expect((await checkImage(flat)).pass).toBe(false);
    const raw = Buffer.alloc(128 * 128 * 3);
    for (let i = 0; i < 128 * 128; i++) raw[i * 3] = (i % 128) * 2;
    const varied = join(dir, 'varied.webp');
    await sharp(raw, { raw: { width: 128, height: 128, channels: 3 } }).webp({ lossless: true }).toFile(varied);
    expect((await checkImage(varied, { width: 128, height: 128 })).pass).toBe(true);
    expect((await checkImage(join(dir, 'missing.webp'))).pass).toBe(false);
  });
});
