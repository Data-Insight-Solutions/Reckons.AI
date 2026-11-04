import { describe, expect, it } from 'vitest';
import { robustExtent } from '../robust-extent';
import { judgeSplatPly } from '../splat-check';

// Deterministic synthetic points only.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A room-shaped slab, 5 x 2.6 x 4 units, filled uniformly. */
function room(n: number, seed = 1): number[] {
  const r = rng(seed);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((r() - 0.5) * 5, r() * 2.6, (r() - 0.5) * 4);
  return out;
}

describe('robustExtent', () => {
  it('matches the raw box on clean points (never larger than it)', () => {
    const r = robustExtent(room(20000))!;
    expect(r.extent).toBeLessThanOrEqual(r.rawExtent + 1e-9);
    expect(r.extent / r.rawExtent).toBeGreaterThan(0.97);
    expect(r.outside / r.count).toBeLessThan(0.01);
  });

  it('ignores a handful of far floaters that would otherwise shrink the room', () => {
    const pts = room(20000);
    // 40 floaters (0.2%), up to 190 units away: the raw box is about 380 long, as the real scan was.
    for (let i = 0; i < 20; i++) pts.push(190 - i, 150, -170 + i);
    for (let i = 0; i < 20; i++) pts.push(-180 + i, -120, 175 - i);
    const r = robustExtent(pts)!;
    expect(r.rawExtent).toBeGreaterThan(300);
    expect(r.extent).toBeLessThan(7); // the 5 unit room, plus margin
    expect(r.extent).toBeGreaterThan(4.9); // and not cut into the walls
    expect(r.outside).toBe(40);
  });

  it('keeps the whole room when floaters sit on one side only', () => {
    const pts = room(10000, 4);
    for (let i = 0; i < 50; i++) pts.push(300 + i, 1, 0);
    const r = robustExtent(pts)!;
    expect(r.box.max[0]).toBeLessThan(10);
    expect(r.box.min[0]).toBeLessThan(-2.4);
    expect(r.outside).toBe(50);
  });

  it('cannot tell a 3% far cluster from the room (documented limit)', () => {
    const pts = room(10000, 9);
    for (let i = 0; i < 300; i++) pts.push(200 + (i % 7), 1, 0);
    const r = robustExtent(pts)!;
    expect(r.extent).toBeGreaterThan(100); // the percentile box reaches the cluster
  });

  it('ignores non-finite centres and returns null when none are usable', () => {
    expect(robustExtent([NaN, 1, 2, Infinity, 0, 0])).toBeNull();
    const r = robustExtent([0, 0, 0, 1, 1, 1, NaN, 0, 0])!;
    expect(r.count).toBe(2);
  });

  it('is exposed as the extent a PLY check measures', () => {
    // A tiny PLY: 2,000 Gaussians in a 4 unit room plus 5 floaters 500 units away.
    const n = 2005;
    const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'];
    const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}`).join('\n')}\nend_header\n`;
    const body = new Float32Array(n * props.length);
    const r = rng(3);
    for (let i = 0; i < n; i++) {
      const far = i >= 2000;
      body.set([far ? 500 + i : (r() - 0.5) * 4, far ? 500 : r() * 2, (r() - 0.5) * 4, 0.1, 0.1, 0.1, 3, -3, -3, -3, 1, 0, 0, 0], i * props.length);
    }
    const bytes = new Uint8Array(head.length + body.byteLength);
    bytes.set(new TextEncoder().encode(head));
    bytes.set(new Uint8Array(body.buffer), head.length);
    const c = judgeSplatPly(bytes);
    expect(c.pass, c.problems.join()).toBe(true);
    expect(Number(c.measured.rawExtent)).toBeGreaterThan(400);
    expect(Number(c.measured.extent)).toBeLessThan(6);
    expect(Number(c.measured.strayFraction)).toBeGreaterThan(0);
  });
});
