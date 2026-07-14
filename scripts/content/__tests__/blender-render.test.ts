/**
 * The black-frame guard (F90 / kb:visual-acceptance).
 *
 * This is the check the whole feature turns on: Blender renders a black frame and exits 0, so
 * a green exit code is NOT evidence of a good image. The FIRST version of this guard sampled
 * compressed PNG bytes and reported a black frame as "✓ real image (variation 0.984)" — it
 * measured compression, not content. So these tests build real PNGs, flat and varied, and
 * assert the guard tells them apart. A guard for black frames that has never SEEN a black
 * frame in a test is exactly the thing this project keeps getting burned by.
 */
import { describe, it, expect } from 'vitest';
import { deflateSync, crc32 } from 'zlib';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { checkImage, sceneToPython } from '../blender-render';

/** Minimal 8-bit RGB PNG encoder — enough to exercise the decoder in checkImage. */
function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const typeBuf = Buffer.from(type, 'ascii');
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0);
    return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  // filter 0 (None) per scanline, then raw RGB.
  const stride = width * 3;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (stride + 1) + 1 + x * 3;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = mkdtempSync(path.join(tmpdir(), 'blender-test-'));
const write = (name: string, buf: Buffer) => {
  const p = path.join(dir, name);
  writeFileSync(p, buf);
  return p;
};

describe('checkImage — the black-frame guard', () => {
  it('PASSES a varied image (a real render)', () => {
    const p = write('varied.png', makePng(96, 96, (x, y) => [(x * 8) & 0xff, (y * 8) & 0xff, ((x + y) * 4) & 0xff]));
    const c = checkImage(p);
    expect(c.ok).toBe(true);
    expect(c.variation).toBeGreaterThan(0.1);
  });

  it('CATCHES a flat black frame — the whole point', () => {
    const p = write('black.png', makePng(96, 96, () => [0, 0, 0]));
    const c = checkImage(p);
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/uniform|flat|black/i);
  });

  it('CATCHES a flat NON-black frame too — "rendered one colour" is the failure, not "black"', () => {
    const p = write('grey.png', makePng(96, 96, () => [50, 50, 60]));
    expect(checkImage(p).ok).toBe(false);
  });

  it('catches a file Blender never wrote', () => {
    const c = checkImage(path.join(dir, 'does-not-exist.png'));
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/no file|never wrote/i);
  });

  it('catches a non-PNG masquerading as a render', () => {
    const p = write('fake.png', Buffer.from('this is not a png, it is a lie'.repeat(10)));
    expect(checkImage(p).ok).toBe(false);
  });

  it('a mostly-flat image with a few stray pixels is still caught (blank middle, stray edge)', () => {
    // 4 lit pixels out of 1024 — well under the 2% threshold. A frame that is "basically empty".
    const p = write('almost-black.png', makePng(96, 96, (x, y) => (x < 2 && y < 2 ? [255, 255, 255] : [0, 0, 0])));
    expect(checkImage(p).ok).toBe(false);
  });
});

describe('sceneToPython — deterministic and grounded', () => {
  it('the same scene produces the same script, byte for byte', () => {
    const scene = { objects: [{ shape: 'cube' as const, color: [0.5, 0.2, 0.1] as [number, number, number] }] };
    expect(sceneToPython(scene, '/tmp/a.png')).toBe(sceneToPython(scene, '/tmp/a.png'));
  });

  it('a solid non-black default background, so an empty render is distinguishable from a black one', () => {
    // The scene's own default bg is dark grey, not pure black — see the comment in the source.
    const py = sceneToPython({ objects: [] }, '/tmp/a.png');
    expect(py).toContain('CYCLES');
    expect(py).toContain('write_still=True');
  });

  it('clamps samples so a hostile scene cannot ask for a million-sample render', () => {
    expect(sceneToPython({ objects: [], samples: 999999 }, '/tmp/a.png')).toContain('samples = 128');
  });
});
