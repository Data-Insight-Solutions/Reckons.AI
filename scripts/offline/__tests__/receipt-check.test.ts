// @vitest-environment node
/**
 * F74.15 receipt self-check: the script finds every receipt.json under a directory, runs
 * validateReceipt on each, prints one line per receipt, and exits 1 naming the one that fails.
 * Synthetic receipts only — nothing here comes from a real capture.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const TSX = join(process.cwd(), 'node_modules/tsx/dist/cli.mjs');
const SCRIPT = join(__dirname, '../receipt-check.ts');

const hash = 'a'.repeat(64);

/** A complete reconstructed receipt whose summary agrees with its check (the check measured 193 of 200). */
function fixtureReceipt(): Record<string, unknown> {
  return {
    origin: 'reconstructed',
    input: { kind: 'video', name: 'room.mp4', sha256: hash, bytes: 10 },
    frames: { extracted: 240, kept: 200, registered: 193, fps: 30 },
    tools: { ffmpeg: 'ffmpeg 7', pycolmap: '4.2.1', brush: 'brush-cli 0.3.0' },
    settings: { totalSteps: 30000 },
    stagesS: { frames: 1, poses: 2, train: 3 },
    gaussians: 1000,
    output: { file: 'splat.ply', sha256: hash, bytes: 99 },
    checks: {
      registration: { pass: true, problems: [], notes: [], measured: { registered: 193, total: 200, fraction: 0.965 } },
      splat: { pass: true, problems: [], notes: [], measured: {} },
    },
    ranAt: '2026-11-10T00:00:00Z',
    notes: [],
  };
}

/** The 2026-11-10 incident shape: the summary says 0 registered while the check measured 193. */
function badReceipt(): Record<string, unknown> {
  const r = fixtureReceipt();
  r.frames = { ...r.frames as object, registered: 0 };
  return r;
}

function writeReceipt(dir: string, receipt: Record<string, unknown>) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt));
}

function run(args: string[]) {
  return spawnSync(process.execPath, [TSX, SCRIPT, ...args], { encoding: 'utf8', cwd: resolve(__dirname, '../../..') });
}

const root = mkdtempSync(join(tmpdir(), 'receipt-check-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('receipt-check', () => {
  it('exits 1 over a directory holding one good and one bad receipt, naming the bad one', () => {
    writeReceipt(join(root, 'good-scan'), fixtureReceipt());
    writeReceipt(join(root, 'nested', 'bad-scan'), badReceipt()); // found by walking, not by listing
    const res = run([root]);
    expect(res.status).toBe(1);
    const out = res.stdout ?? '';
    // One line per receipt, and the bad one is named with both values from its disagreement.
    expect(out).toContain('good-scan/receipt.json');
    expect(out).toMatch(/FAIL\s+nested\/bad-scan\/receipt\.json/);
    expect(out).toContain('frames.registered is 0');
    expect(out).toContain('measured 193');
    expect(out).toContain('1 of 2 receipt(s) agree with their own checks');
  });

  it('exits 0 when every receipt agrees with its own check', () => {
    const allGood = join(root, 'all-good');
    writeReceipt(join(allGood, 'one'), fixtureReceipt());
    const res = run([allGood]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('one/receipt.json');
    expect(res.stdout).toContain('1 of 1 receipt(s) agree with their own checks');
  });

  it('refuses to run without a directory', () => {
    const res = run([]);
    expect(res.status).not.toBe(0);
    expect((res.stderr ?? '') + (res.stdout ?? '')).toMatch(/one directory is required|usage/);
  });

  it('refuses a directory that does not exist', () => {
    const res = run([join(root, 'no-such-dir')]);
    expect(res.status).toBe(2);
    expect((res.stderr ?? '') + (res.stdout ?? '')).toMatch(/not a directory/);
  });
});
