import { describe, expect, it } from 'vitest';
import { DEFAULT_RAM_LIMITS, mergeRamLimits, parseAnonMiB, parseMeminfo, ramStartVerdict, ramWatchVerdict } from '../session-ram.js';
import { newJob, parseQueue } from '../session-queue.js';
import { resolveThresholds } from '../device-config.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIB = 1048576;
// Synthetic /proc/meminfo: 31.3 GiB total, 17.3 GiB available (the 2026-11-04 12:30 reading).
const MEMINFO = 'MemTotal:       32820000 kB\nMemFree:         1200000 kB\nMemAvailable:   18140000 kB\nSwapTotal:       2097148 kB\n';

describe('parseMeminfo / parseAnonMiB', () => {
  it('reads total and available MiB', () => {
    const m = parseMeminfo(MEMINFO)!;
    expect(Math.round(m.totalMiB)).toBe(32051);
    expect(Math.round(m.availMiB)).toBe(17715);
  });
  it('is null when MemAvailable is missing', () => {
    expect(parseMeminfo('MemTotal: 100 kB\n')).toBeNull();
  });
  it('reads the anon line of a cgroup memory.stat, not anon_thp', () => {
    expect(parseAnonMiB(`anon_thp 0\nanon ${18 * 1024 * MIB}\nfile 473485312\n`)).toBe(18 * 1024);
    expect(parseAnonMiB('file 1\n')).toBeNull();
  });
});

describe('ramStartVerdict', () => {
  it('holds a GPU job when available RAM is under the start limit', () => {
    const v = ramStartVerdict({ totalMiB: 32000, availMiB: 4000 });
    expect(v).toMatchObject({ ok: false, kind: 'low' });
  });
  it('passes with room, and passes when memory is unknown (non-Linux)', () => {
    expect(ramStartVerdict({ totalMiB: 32000, availMiB: 17000 }).ok).toBe(true);
    expect(ramStartVerdict(null).ok).toBe(true);
  });
});

describe('ramWatchVerdict', () => {
  const roomy = { totalMiB: 32000, availMiB: 17000 };
  it('a fully offloaded model (a few hundred MiB anon) passes', () => {
    expect(ramWatchVerdict({ mem: roomy, anonMiB: 700 }).ok).toBe(true);
  });
  it('stops a model loading into RAM (the 2026-11-04 CPU_REPACK load reached 18 GiB anon)', () => {
    const v = ramWatchVerdict({ mem: roomy, anonMiB: 7000 });
    expect(v).toMatchObject({ ok: false, kind: 'spill' });
  });
  it('a --ram-spill job skips the spill check', () => {
    expect(ramWatchVerdict({ mem: roomy, anonMiB: 20000 }, DEFAULT_RAM_LIMITS, true).ok).toBe(true);
  });
  it('the floor applies even to a --ram-spill job, and wins over spill', () => {
    const low = { totalMiB: 32000, availMiB: 1500 };
    expect(ramWatchVerdict({ mem: low, anonMiB: 100 }, DEFAULT_RAM_LIMITS, true)).toMatchObject({ ok: false, kind: 'floor' });
    expect(ramWatchVerdict({ mem: low, anonMiB: 20000 })).toMatchObject({ ok: false, kind: 'floor' });
  });
  it('unknown readings never stop a job', () => {
    expect(ramWatchVerdict({ mem: null, anonMiB: null }).ok).toBe(true);
  });
});

describe('limits', () => {
  it('device overrides replace a default; junk keeps it', () => {
    const l = mergeRamLimits({ ramSpillAnonMiB: { limit: 8192 }, ramFloorAvailMiB: { limit: Number.NaN }, ramStartAvailMiB: { limit: -1 } });
    expect(l).toEqual({ ...DEFAULT_RAM_LIMITS, spillAnonMiB: 8192 });
  });
  it('the shipped device defaults carry all four limits at the coded defaults', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const ttl = readFileSync(path.join(here, '..', 'defaults', 'device-defaults.ttl'), 'utf8');
    expect(mergeRamLimits(resolveThresholds([ttl], 'any-host'), { startAvailMiB: 1, floorAvailMiB: 1, spillAnonMiB: 1, hardAnonMiB: 1 })).toEqual(DEFAULT_RAM_LIMITS);
  });
});

describe('ramSpill on a queued job', () => {
  it('survives a write and read of the queue file; absent stays absent', () => {
    const a = newJob('bench-120b', '/tmp', ['echo'], undefined, undefined, undefined, true);
    const b = newJob('plain', '/tmp', ['echo']);
    const back = parseQueue([a, b].map((j) => JSON.stringify(j)).join('\n'));
    expect(back[0].ramSpill).toBe(true);
    expect('ramSpill' in back[1]).toBe(false);
  });
});

import { residencyFromPs, SPILL_GRACE_MS } from '../session-ram';

describe('spill guard with GPU residency (2026-11-05)', () => {
  const sample = (anonMiB: number) => ({ mem: { totalMiB: 31_000, availMiB: 20_000 }, anonMiB });
  it('reads residency from /api/ps', () => {
    expect(residencyFromPs({ models: [{ size: 100, size_vram: 100 }] })).toBe('all-gpu');
    expect(residencyFromPs({ models: [{ size: 100, size_vram: 60 }] })).toBe('spilled');
    expect(residencyFromPs({ models: [] })).toBe('unknown');
    expect(residencyFromPs(null)).toBe('unknown');
    expect(residencyFromPs({ models: [{ size: 100 }] })).toBe('unknown');
  });
  it('lets a load whose model ends fully on the GPU pass the soft limit (the 6.1 GiB false stop)', () => {
    expect(ramWatchVerdict(sample(6_250), undefined, false, { residency: 'all-gpu', overSoftForMs: 10_000 }).ok).toBe(true);
  });
  it('stops when Ollama reports a model partly in system RAM', () => {
    const v = ramWatchVerdict(sample(6_250), undefined, false, { residency: 'spilled', overSoftForMs: 1_000 });
    expect(v.ok).toBe(false);
  });
  it('waits out an unknown residency only for the grace, then stops', () => {
    expect(ramWatchVerdict(sample(6_250), undefined, false, { residency: 'unknown', overSoftForMs: SPILL_GRACE_MS - 1 }).ok).toBe(true);
    expect(ramWatchVerdict(sample(6_250), undefined, false, { residency: 'unknown', overSoftForMs: SPILL_GRACE_MS + 1 }).ok).toBe(false);
  });
  it('stops at once above the hard limit, whatever Ollama says (the 2026-11-04 crash reached 17 GB)', () => {
    const v = ramWatchVerdict(sample(12_500), undefined, false, { residency: 'all-gpu', overSoftForMs: 0 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toMatch(/hard limit/);
  });
  it('keeps the old rule when called without residency (fail-safe)', () => {
    expect(ramWatchVerdict(sample(6_250)).ok).toBe(false);
  });
});
