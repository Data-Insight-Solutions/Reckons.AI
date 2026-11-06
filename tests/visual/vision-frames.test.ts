/**
 * F93.1 (kb:video-frame-sampling) — frame sampling as a working part of the visual testing suite.
 *
 * The failure this exists for (2026-11-05): the first demo render had grey margins around the app in
 * every frame — a 1280x800 viewport inside 1920x1080 — and step 1's narration did not match its
 * screens. Both were found only because a person extracted a contact sheet by hand with ffmpeg.
 * These tests pin the shared sampler that F275.10 (demo QA) will judge against: frames come back at
 * the asked times (within one frame), a padded video is found to have margins, an unpadded one is
 * not, a black video is blank, and — the regression that motivated the job — asset-checks' motion
 * measure, rebuilt on this sampler, gives the SAME numbers as before on the committed clips
 * (recorded 2026-11-05 from the old select=eq(n,0/last) reads: carved-turtle 0.2061,
 * lighthouse-island 0.0543).
 *
 * ffmpeg/ffprobe are not a repository dependency; where a test needs them it skips, so a CI without
 * them does not fail for lack of the tool. The pure frame-rule tests never need ffmpeg at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  type GrayFrame, probeDurationMs, cadence, sampleFrames, isBlank, uniformMargins, hasMargins, meanAbsDiff,
} from './vision-frames';
import { checkVideo } from '../../scripts/content/asset-checks';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'vision-frames-')); });
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

/** Make a synthetic video in the temp dir with an ffmpeg lavfi source. */
function makeVideo(name: string, args: string[]): string {
  const file = join(dir, name);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...args, file]);
  return file;
}

/** A solid or per-pixel greyscale frame, for the pure rules (no ffmpeg needed). */
function frame(width: number, height: number, fill: number | ((x: number, y: number) => number)): GrayFrame {
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) gray[y * width + x] = typeof fill === 'function' ? fill(x, y) : fill;
  return { atMs: 0, width, height, gray };
}

const mean = (f: GrayFrame): number => f.gray.reduce((s, p) => s + p, 0) / f.gray.length;

// ── Pure frame rules ─────────────────────────────────────────────────────────

describe('cadence', () => {
  it('is 0, every, 2*every, … strictly before the duration', () => {
    expect(cadence(2500, 500)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(cadence(1000, 250)).toEqual([0, 250, 500, 750]);
    expect(cadence(0, 500)).toEqual([]);
  });
  it('refuses a non-positive step', () => {
    expect(() => cadence(1000, 0)).toThrow();
    expect(() => cadence(1000, -10)).toThrow();
  });
});

describe('meanAbsDiff', () => {
  it('is 0 for identical frames, 1 for opposite, 0.5 for a 128 offset', () => {
    const a = frame(8, 8, 40), b = frame(8, 8, 40);
    expect(meanAbsDiff(a, b)).toBe(0);
    expect(meanAbsDiff(frame(8, 8, 0), frame(8, 8, 255))).toBe(1);
    expect(meanAbsDiff(frame(8, 8, 0), frame(8, 8, 128))).toBeCloseTo(128 / 255, 10);
  });
  it('throws on a size mismatch rather than comparing misaligned pixels', () => {
    expect(() => meanAbsDiff(frame(8, 8, 0), frame(16, 4, 0))).toThrow();
    expect(() => meanAbsDiff(frame(8, 8, 0), frame(8, 16, 0))).toThrow();
  });
});

describe('isBlank (pure frames)', () => {
  it('is true for a solid frame and false for a varied one', () => {
    expect(isBlank(frame(16, 16, 128))).toBe(true);
    expect(isBlank(frame(16, 16, (x) => x * 16))).toBe(false);
  });
  it('honours the maxStdDev threshold', () => {
    // std dev of [0, 255] half-and-half is about 127.5: blank at 200, not at 100.
    const f = frame(4, 4, (x) => (x < 2 ? 0 : 255));
    expect(isBlank(f, 200)).toBe(true);
    expect(isBlank(f, 100)).toBe(false);
  });
});

describe('uniformMargins / hasMargins (pure frames)', () => {
  it('measures each solid band at exactly its fraction', () => {
    // A grey band on the left, black everywhere else: the black is itself a solid band on the
    // right, so both sides measure — the content sits between two margins, and that is what this
    // frame is. Rows mix both colours, so top and bottom are 0.
    const f = frame(100, 50, (x) => (x < 20 ? 128 : 0));
    expect(uniformMargins(f)).toEqual({ left: 0.2, right: 0.8, top: 0, bottom: 0 });
    expect(hasMargins(f)).toBe(true);
  });
  it('finds all four bands of a padded frame', () => {
    const f = frame(480, 270, (x, y) => (x >= 80 && x < 400 && y >= 45 && y < 225 ? 20 : 128));
    const m = uniformMargins(f);
    expect(m.left).toBeCloseTo(80 / 480, 5);
    expect(m.right).toBeCloseTo(80 / 480, 5);
    expect(m.top).toBeCloseTo(45 / 270, 5);
    expect(m.bottom).toBeCloseTo(45 / 270, 5);
  });
  it('does not call a varied frame margined', () => {
    const f = frame(64, 36, (x, y) => (x + y * 7) % 256);
    expect(hasMargins(f)).toBe(false);
  });
  it('respects a raised minFraction', () => {
    // One 0.1-wide grey band, a varied pattern elsewhere: margined at the default 0.08, not at 0.25.
    const f = frame(100, 50, (x, y) => (x < 10 ? 128 : (x * 31 + y * 17) % 251));
    expect(hasMargins(f)).toBe(true);
    expect(hasMargins(f, 0.25)).toBe(false);
  });
});

// ── The ffmpeg sampler ───────────────────────────────────────────────────────

describe.skipIf(!hasFfmpeg)('sampleFrames on synthetic videos', () => {
  /** 320x180 at 5 fps, 1.2 s: frame N is solid grey N*51 (0, 51, …, 255) at pts 0, 0.2, …, 1.0. */
  let stepped: string;
  /** The failure of 2026-11-05 as a synthetic: a 320x180 pattern padded to 480x270 with grey 80x45 margins. */
  let padded: string;
  let unpadded: string;
  let black: string;

  beforeAll(() => {
    stepped = makeVideo('stepped.webm', ['-f', 'lavfi', '-i', 'color=black:s=320x180:d=1.2:r=5',
      '-vf', "geq=lum='N*51':cb=128:cr=128", '-c:v', 'libvpx', '-an']);
    padded = makeVideo('padded.webm', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2',
      '-vf', 'pad=480:270:80:45:gray', '-c:v', 'libvpx', '-an']);
    unpadded = makeVideo('unpadded.webm', ['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=2', '-c:v', 'libvpx', '-an']);
    black = makeVideo('black.webm', ['-f', 'lavfi', '-i', 'color=black:size=320x180:duration=1', '-c:v', 'libvpx', '-an']);
  });

  it('probes the duration in milliseconds', () => {
    const ms = probeDurationMs(stepped);
    expect(ms).toBeGreaterThanOrEqual(1100);
    expect(ms).toBeLessThanOrEqual(1300);
  });

  it('comes back at the asked time, within one frame', () => {
    const [f] = sampleFrames(stepped, [500]);
    expect(f.width).toBe(96);
    expect(Number.isInteger(f.height) && f.height % 2 === 0).toBe(true);
    expect(f.gray.length).toBe(f.width * f.height);
    // Asked 500 ms at 5 fps: the neighbouring frames are 400 ms (102) and 600 ms (153). Anything at
    // 200 ms (51) or 800 ms (204) or further is more than one frame off.
    expect(mean(f)).toBeGreaterThanOrEqual(80);
    expect(mean(f)).toBeLessThanOrEqual(175);
  });

  it('takes the first frame at time 0', () => {
    const [f] = sampleFrames(stepped, [0]);
    expect(mean(f)).toBeLessThanOrEqual(20);
  });

  it('clamps a time past the end to the last frame', () => {
    const [f] = sampleFrames(stepped, [5000]);
    // Last frame is 255; one step short is 204. Anything earlier is not the last frame.
    expect(mean(f)).toBeGreaterThanOrEqual(190);
    expect(mean(f)).toBeLessThanOrEqual(255);
  });

  it('finds the grey margins on the padded video and none on the unpadded one', () => {
    const [p] = sampleFrames(padded, [1000]);
    const m = uniformMargins(p);
    // 80/480 = 45/270 ≈ 0.1667; leave room for codec blur at the boundary.
    for (const side of [m.left, m.right, m.top, m.bottom]) {
      expect(side).toBeGreaterThan(0.1);
      expect(side).toBeLessThan(0.25);
    }
    expect(hasMargins(p)).toBe(true);

    const [u] = sampleFrames(unpadded, [1000]);
    expect(hasMargins(u)).toBe(false);
  });

  it('calls the black video blank and the testsrc video not', () => {
    expect(isBlank(sampleFrames(black, [500])[0])).toBe(true);
    expect(isBlank(sampleFrames(unpadded, [1000])[0])).toBe(false);
  });

  it('writes <pngDir>/<atMs>.png at full size when asked', async () => {
    const pngDir = join(dir, 'pngs');
    sampleFrames(padded, [1000], { pngDir });
    expect(readdirSync(pngDir)).toContain('1000.png');
    const meta = await sharp(join(pngDir, '1000.png')).metadata();
    expect(meta.width).toBe(480);
    expect(meta.height).toBe(270);
  });
});

// ── The regression this job exists for ───────────────────────────────────────

describe.skipIf(!hasFfmpeg)('asset-checks motion on the committed clips', () => {
  // Recorded 2026-11-05 from the pre-refactor reads (select=eq(n,0) / select=eq(n,frames-1),
  // scale=64:64, 512x512 49-frame 3 s clips). The refactor must reproduce these exactly.
  const baselines: [string, number][] = [
    ['static/generated/carved-turtle/video.webm', 0.2061],
    ['static/generated/lighthouse-island/video.webm', 0.0543],
  ];

  it('gives the same numbers as before on every committed clip', () => {
    for (const [file, motion] of baselines) {
      expect(existsSync(file), `${file} is tracked by git and must be present`).toBe(true);
      const c = checkVideo(file);
      expect(c.pass, c.problems.join('; ')).toBe(true);
      expect(c.measured.width).toBe(512);
      expect(c.measured.frames).toBe(49);
      expect(c.measured.motion).toBe(motion);
    }
  });

  it('computes those numbers through the shared sampler', () => {
    for (const [file, motion] of baselines) {
      const durationMs = probeDurationMs(file);
      const [first, last] = sampleFrames(file, [0, durationMs], { width: 64, height: 64 });
      expect(first.width).toBe(64);
      expect(first.height).toBe(64);
      expect(Number(meanAbsDiff(first, last).toFixed(4))).toBe(motion);
    }
  });
});
