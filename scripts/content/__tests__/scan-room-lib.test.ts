import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import {
  chooseFps, detectInput, folderContentHash, isCuratedFrames, judgeRegistration, MIN_CURATED_IMAGES, parseOdometry, pathLength, selectSharpest, strayMissing,
  validateReceipt, type ScanReceipt,
} from '../scan-room-lib';

// Synthetic fixtures only: nothing here comes from a real capture.
const STRAY = ['rgb.mp4', 'odometry.csv', 'camera_matrix.csv', 'depth', 'confidence'];

describe('input detection', () => {
  it('treats a video file as a plain video', () => {
    expect(detectInput('/x/room.MOV', false)).toEqual({ kind: 'video', video: '/x/room.MOV' });
  });
  it('refuses a non-video file', () => {
    expect(() => detectInput('/x/notes.txt', false)).toThrow(/not a video file/);
  });
  it('accepts a complete Stray Scanner folder', () => {
    const r = detectInput('/x/scan/', true, STRAY);
    expect(r.kind).toBe('stray');
    expect(r.video).toBe('/x/scan/rgb.mp4');
  });
  it('names what a folder lacks instead of guessing', () => {
    expect(strayMissing(['rgb.mp4'])).toEqual(['odometry.csv', 'camera_matrix.csv']);
    expect(() => detectInput('/x/scan', true, ['rgb.mp4', 'depth'])).toThrow(/missing odometry.csv, camera_matrix.csv/);
  });
});

describe('odometry.csv', () => {
  const csv = 'timestamp, frame, x, y, z, qx, qy, qz, qw\n0.0, 0, 0, 0, 0, 0, 0, 0, 1\n0.1, 1, 3, 4, 0, 0, 0, 0, 1\n\n0.2, 2, 3, 4, 12, 0, 0, 0, 1\n';
  it('parses rows by header name', () => {
    const rows = parseOdometry(csv);
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatchObject({ frame: 1, position: [3, 4, 0], quaternion: [0, 0, 0, 1] });
  });
  it('measures path length', () => { expect(pathLength(parseOdometry(csv))).toBeCloseTo(17); });
  it('reorders columns by header', () => {
    const r = parseOdometry('frame,timestamp,qw,qx,qy,qz,z,y,x\n5,0.5,1,0,0,0,3,2,1\n');
    expect(r[0]).toMatchObject({ frame: 5, timestamp: 0.5, position: [1, 2, 3], quaternion: [0, 0, 0, 1] });
  });
  it('rejects empty, headerless and non-numeric input', () => {
    expect(() => parseOdometry('')).toThrow(/empty/);
    expect(() => parseOdometry('a,b\n1,2\n')).toThrow(/header lacks/);
    expect(() => parseOdometry('timestamp,frame,x,y,z,qx,qy,qz,qw\n0,0,x,0,0,0,0,0,1\n')).toThrow(/non-numeric/);
  });
});

describe('frame selection', () => {
  it('chooses an fps that lands near the target frame count', () => {
    expect(chooseFps(60, 30, 200)).toBeCloseTo(3.333, 2);
    expect(chooseFps(5, 30, 200)).toBe(30); // never above the native rate
    expect(() => chooseFps(0, 30)).toThrow();
  });
  it('keeps the sharpest frames in original order', () => {
    expect(selectSharpest([5, 1, 9, 2, 7], 3)).toEqual([0, 2, 4]);
    expect(selectSharpest([1, 2], 5)).toEqual([0, 1]);
  });
  it('does not exceed the requested count when scores tie', () => {
    expect(selectSharpest([4, 4, 4, 4], 2)).toHaveLength(2);
  });
});

describe('registration check', () => {
  it('passes at half or more', () => {
    expect(judgeRegistration(100, 200).pass).toBe(true);
    expect(judgeRegistration(150, 200).measured.fraction).toBe(0.75);
  });
  it('fails below half and says the numbers', () => {
    const c = judgeRegistration(99, 200);
    expect(c.pass).toBe(false);
    expect(c.problems[0]).toMatch(/registered 99 of 200/);
  });
  it('fails with no frames', () => { expect(judgeRegistration(0, 0).pass).toBe(false); });
});

describe('receipt shape', () => {
  const ok = { pass: true, problems: [], notes: [], measured: {} };
  const hash = 'a'.repeat(64);
  const receipt = (): ScanReceipt => ({
    origin: 'reconstructed',
    input: { kind: 'video', name: 'room.mp4', sha256: hash, bytes: 10 },
    frames: { extracted: 240, kept: 200, registered: 190, fps: 30 },
    tools: { ffmpeg: 'ffmpeg 7', pycolmap: '4.2.1', brush: 'brush-cli 0.3.0' },
    settings: { totalSteps: 30000 },
    stagesS: { frames: 1, poses: 2, train: 3 },
    gaussians: 1000,
    output: { file: 'splat.ply', sha256: hash, bytes: 99 },
    checks: { registration: ok, splat: ok },
    ranAt: '2026-10-14T00:00:00Z',
    notes: [],
  });
  it('accepts a complete reconstructed receipt', () => { expect(validateReceipt(receipt())).toEqual([]); });
  it('refuses a receipt that is not labelled reconstructed', () => {
    const r = { ...receipt(), origin: 'generated' } as unknown as ScanReceipt;
    expect(validateReceipt(r).join()).toMatch(/must be reconstructed/);
  });
  it('refuses missing hashes, versions, durations and failed checks', () => {
    const r = receipt();
    r.input.sha256 = 'nope'; r.tools.brush = ''; delete r.stagesS.train; r.checks.splat = { ...ok, pass: false };
    const p = validateReceipt(r).join('\n');
    expect(p).toMatch(/input sha256/);
    expect(p).toMatch(/tool version missing: brush/);
    expect(p).toMatch(/stage duration missing: train/);
    expect(p).toMatch(/splat check did not pass/);
  });
  it('refuses more registered frames than kept', () => {
    const r = receipt(); r.frames.registered = 201;
    expect(validateReceipt(r).join()).toMatch(/inconsistent/);
  });
  describe('self-consistency (F74.15)', () => {
    it('fails a summary that disagrees with the check, naming both values', () => {
      // The 2026-11-10 incident as a fixture: the summary said 0 while the check measured 193 of 200.
      const r = receipt();
      r.frames.registered = 0;
      r.checks.registration = { pass: true, problems: [], notes: [], measured: { registered: 193, total: 200, fraction: 0.965 } };
      const p = validateReceipt(r).join('\n');
      expect(p).toMatch(/frames\.registered is 0/);
      expect(p).toMatch(/measured 193/);
    });
    it('passes a summary that is the check\'s measured value', () => {
      const r = receipt();
      r.frames.registered = 193;
      r.checks.registration = { pass: true, problems: [], notes: [], measured: { registered: 193, total: 200, fraction: 0.965 } };
      expect(validateReceipt(r)).toEqual([]);
    });
  });
  describe('compressed copy (F58.9.11)', () => {
    const withCopy = (): ScanReceipt => ({
      ...receipt(),
      compressed: { format: 'sog', lossy: true, file: 'splat.sog', sha256: hash, bytes: 10, ratio: 9.9, gaussians: 1000, extent: 5, check: { pass: true, problems: [] } },
    });
    it('accepts a receipt with a decoded, lossy, smaller copy', () => { expect(validateReceipt(withCopy())).toEqual([]); });
    it('refuses a copy that is not smaller, lost Gaussians, failed its decode or hides that it is lossy', () => {
      const r = withCopy();
      Object.assign(r.compressed!, { ratio: 1, gaussians: 999, lossy: false });
      r.compressed!.check = { pass: false, problems: ['x'] };
      const p = validateReceipt(r).join('\n');
      expect(p).toMatch(/not a reduction/);
      expect(p).toMatch(/999 Gaussians, output has 1000/);
      expect(p).toMatch(/not recorded as lossy/);
      expect(p).toMatch(/decode check did not pass/);
    });
  });
  describe('floater crop (F58.9.11)', () => {
    const withCrop = (): ScanReceipt => ({
      ...receipt(),
      crop: { box: { min: [0, 0, 0], max: [5, 3, 4] }, before: 1010, after: 1000, removed: 10, rawExtent: 380, extent: 5, uncropped: { file: 'splat.uncropped.ply', sha256: hash, bytes: 99 } },
    });
    it('accepts a crop whose counts add up', () => { expect(validateReceipt(withCrop())).toEqual([]); });
    it('refuses counts that do not add up, a crop that is not the output, or a bigger extent', () => {
      const r = withCrop();
      r.crop!.removed = 9; r.crop!.after = 999; r.crop!.extent = 400;
      const p = validateReceipt(r).join('\n');
      expect(p).toMatch(/do not add up|crop counts/);
      expect(p).toMatch(/crop kept 999 Gaussians, output has 1000/);
      expect(p).toMatch(/larger than the raw extent/);
    });
  });
});

// F58.9.6.1: a folder of hand-picked images. Synthetic tiny images in a temp folder only.
describe('curated image folder', () => {
  const root = mkdtempSync(join(tmpdir(), 'curated-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const tiny = (shade: number) => sharp({ create: { width: 8, height: 8, channels: 3, background: { r: shade, g: shade, b: shade } } });
  const make = async (name: string, files: Record<string, number | string>) => {
    const dir = join(root, name);
    mkdirSync(dir);
    for (const [f, v] of Object.entries(files)) {
      if (typeof v === 'string') writeFileSync(join(dir, f), v);
      else await (f.endsWith('.png') ? tiny(v).png() : tiny(v).jpeg()).toFile(join(dir, f));
    }
    return { dir, listing: readdirSync(dir) };
  };

  it('treats a folder of jpg and png images as kind images, in name order, ignoring other files', async () => {
    const { dir, listing } = await make('a', { 'f0002.jpg': 10, 'f0001.png': 20, 'f0003.JPEG': 30, 'notes.txt': 'x' });
    const r = detectInput(dir, true, listing);
    expect(r).toEqual({ kind: 'images', dir, images: ['f0001.png', 'f0002.jpg', 'f0003.JPEG'] });
  });
  it('still refuses an empty folder and a folder with no images, naming the Stray files it lacks', async () => {
    const { dir, listing } = await make('b', { 'readme.txt': 'x' });
    expect(() => detectInput(dir, true, listing)).toThrow(/not a Stray Scanner export \(missing rgb.mp4, odometry.csv, camera_matrix.csv\)/);
  });
  it('does not reinterpret a partial Stray export as images, even when it holds a picture', () => {
    expect(() => detectInput('/x/scan', true, ['rgb.mp4', 'cover.jpg'])).toThrow(/missing odometry.csv, camera_matrix.csv/);
  });
  it('leaves video and Stray detection unchanged', () => {
    expect(detectInput('/x/room.mp4', false)).toEqual({ kind: 'video', video: '/x/room.mp4' });
    expect(detectInput('/x/scan', true, [...STRAY, 'extra.jpg']).kind).toBe('stray');
  });

  describe('folder hash', () => {
    const e = [{ name: 'f1.jpg', sha256: 'a'.repeat(64) }, { name: 'f2.jpg', sha256: 'b'.repeat(64) }];
    it('is stable under listing order and changes with any name or content change', () => {
      const h = folderContentHash(e);
      expect(h).toMatch(/^[0-9a-f]{64}$/);
      expect(folderContentHash([...e].reverse())).toBe(h);
      expect(folderContentHash([e[0]])).not.toBe(h);
      expect(folderContentHash([{ ...e[0], sha256: 'c'.repeat(64) }, e[1]])).not.toBe(h);
      expect(folderContentHash([{ ...e[0], name: 'f9.jpg' }, e[1]])).not.toBe(h);
    });
  });

  describe('receipt for supplied frames', () => {
    const ok = { pass: true, problems: [], notes: [], measured: { registered: 190, total: 200, fraction: 0.95 } };
    const hash = 'a'.repeat(64);
    const curatedReceipt = (): ScanReceipt => ({
      origin: 'reconstructed',
      input: { kind: 'images', name: 'frames', sha256: hash, bytes: 10 },
      frames: { source: 'curated', supplied: 200, kept: 200, registered: 190, folderSha256: hash },
      tools: { ffmpeg: 'ffmpeg 7', pycolmap: '4.2.1', brush: 'brush-cli 0.3.0' },
      settings: { totalSteps: 30000 },
      stagesS: { frames: 1, poses: 2, train: 3 },
      gaussians: 1000,
      output: { file: 'splat.ply', sha256: hash, bytes: 99 },
      checks: { registration: ok, splat: { pass: true, problems: [], notes: [], measured: {} } },
      ranAt: '2026-11-12T00:00:00Z',
      notes: [],
    });
    it('is accepted with no extraction numbers', () => {
      const r = curatedReceipt();
      expect(isCuratedFrames(r.frames)).toBe(true);
      expect(validateReceipt(r)).toEqual([]);
    });
    it('refuses a count that was not used as given, a folder hash that is not the input hash, and too few frames', () => {
      const r = curatedReceipt();
      Object.assign(r.frames, { kept: 150 });
      expect(validateReceipt(r).join()).toMatch(/used as given/);
      const r2 = curatedReceipt();
      r2.input.sha256 = 'd'.repeat(64);
      expect(validateReceipt(r2).join()).toMatch(/input sha256 must be the curated folder hash/);
      const r3 = curatedReceipt();
      r3.frames = { source: 'curated', supplied: MIN_CURATED_IMAGES - 1, kept: MIN_CURATED_IMAGES - 1, registered: 5, folderSha256: hash };
      expect(validateReceipt(r3).join()).toMatch(/need at least/);
    });
    it('refuses curated frames on a video input and an image input with extracted numbers', () => {
      const r = curatedReceipt();
      r.input.kind = 'video';
      expect(validateReceipt(r).join()).toMatch(/not an image folder/);
      const r2 = curatedReceipt();
      r2.frames = { extracted: 240, kept: 200, registered: 190, fps: 30 };
      expect(validateReceipt(r2).join()).toMatch(/must record its frames as curated/);
    });
    it('still validates an ordinary extracted receipt exactly as before', () => {
      const r = curatedReceipt();
      r.input = { kind: 'video', name: 'room.mp4', sha256: hash, bytes: 10 };
      r.frames = { extracted: 240, kept: 200, registered: 190, fps: 30 };
      expect(validateReceipt(r)).toEqual([]);
    });
  });
});
