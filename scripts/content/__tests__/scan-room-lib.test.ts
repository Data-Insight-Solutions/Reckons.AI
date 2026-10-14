import { describe, expect, it } from 'vitest';
import {
  chooseFps, detectInput, judgeRegistration, parseOdometry, pathLength, selectSharpest, strayMissing,
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
});
