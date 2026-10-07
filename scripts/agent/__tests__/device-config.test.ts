import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey, compileSchedules, defaultsPath, legacyWatchToTurtle, loadDeviceConfig, resolveThresholds } from '../device-config';
import { DEFAULT_GPU_LIMITS, mergeGpuLimits } from '../session-gpu';
import { DEFAULT_THRESHOLDS, mergeThresholds } from '../watch-render';

const HEAD = '@prefix kpred: <urn:kbase:predicate/> . @prefix ktype: <urn:kbase:type/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n';
const defaults = readFileSync(defaultsPath(), 'utf8');
const dev = (slug: string, host: string) => `<urn:reckons:device/${slug}> a ktype:DeviceProfile ; kpred:hostname "${host}" .\n`;
const th = (slug: string, metric: string, props: string) => `<urn:reckons:threshold/${metric}/${slug}> a ktype:Threshold ; rdfs:label "${metric}" ; kpred:device <urn:reckons:device/${slug}> ; ${props} .\n`;

describe('defaults file', () => {
  it('equals the code fallbacks, so the two cannot drift', () => {
    const r = resolveThresholds([defaults], 'any');
    expect(mergeThresholds(r)).toEqual(DEFAULT_THRESHOLDS);
    expect(mergeGpuLimits(r)).toEqual(DEFAULT_GPU_LIMITS);
  });
});

describe('defaults + override merge, per property', () => {
  const override = HEAD + dev('box', 'box') + th('box', 'gpuUtil', 'kpred:yellow 50') + th('box', 'startTempC', 'kpred:limit 75');
  it('an override of one property keeps the default of the other', () => {
    const r = resolveThresholds([defaults, override], 'box');
    expect(r.gpuUtil).toEqual({ yellow: 50, red: 98 });
    expect(r.startTempC).toEqual({ limit: 75 });
    expect(r.vramPct).toEqual({ yellow: 85, red: 95 });
    expect(mergeGpuLimits(r)).toEqual({ ...DEFAULT_GPU_LIMITS, tempC: 75 });
  });
  it('a host-specific group beats a wildcard one in the SAME file', () => {
    const same = HEAD + dev('all', '*') + dev('box', 'box') + th('box', 'gpuUtil', 'kpred:yellow 50') + th('all', 'gpuUtil', 'kpred:yellow 60');
    expect(resolveThresholds([same], 'box').gpuUtil.yellow).toBe(50);
  });
});

describe('hostname scoping', () => {
  const two = HEAD + dev('a', 'alpha') + dev('b', 'beta') + th('a', 'gpuUtil', 'kpred:yellow 10') + th('b', 'gpuUtil', 'kpred:yellow 20');
  it('applies only the matching machine, case-insensitively', () => {
    expect(resolveThresholds([defaults, two], 'alpha').gpuUtil.yellow).toBe(10);
    expect(resolveThresholds([defaults, two], 'BETA').gpuUtil.yellow).toBe(20);
    expect(resolveThresholds([defaults, two], 'gamma').gpuUtil.yellow).toBe(85);
  });
  it('scopes schedule overrides by property, by IRI, and drops other hosts', () => {
    const base = HEAD + '<urn:reckons:schedule/x> a ktype:Schedule ; rdfs:label "X" ; kpred:every "1d" ; kpred:command "true" ; kpred:tier "script" .\n';
    const over = HEAD + dev('a', 'alpha') + dev('b', 'beta') + '<urn:reckons:schedule/x> kpred:device <urn:reckons:device/a> ; kpred:every "1w" .\n<urn:reckons:schedule/y> a ktype:Schedule ; kpred:device <urn:reckons:device/b> ; kpred:every "1h" ; kpred:command "z" .\n';
    const on = (host: string) => compileSchedules([base, over], host).map((s) => [s.iri.split('/').pop(), s.every, s.command, s.tier]);
    expect(on('alpha')).toEqual([['x', '1w', 'true', 'script']]);
    expect(on('beta')).toEqual([['x', '1d', 'true', 'script'], ['y', '1h', 'z', undefined]]);
  });
});

describe('cache keyed by mtime', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'devcfg-'));
    process.env.XDG_STATE_HOME = dir;
    process.env.RECKONS_DEVICE_TTL = path.join(dir, 'device.ttl');
  });
  afterEach(() => { process.env = { ...saved }; vi.restoreAllMocks(); });

  it('key changes with host or any mtime', () => {
    expect(cacheKey('h', [1, 2, 3])).not.toBe(cacheKey('h', [1, 2, 4]));
    expect(cacheKey('h', [1, 2, 3])).not.toBe(cacheKey('g', [1, 2, 3]));
  });
  it('is reused until a source changes, then recompiled', () => {
    const f = process.env.RECKONS_DEVICE_TTL!;
    const root = dir; // no schedules.ttl here: defaults only
    writeFileSync(f, HEAD + dev('h', 'h') + th('h', 'gpuUtil', 'kpred:yellow 11'));
    utimesSync(f, new Date(5_000_000), new Date(5_000_000));
    expect(loadDeviceConfig(root, 'h').thresholds.gpuUtil.yellow).toBe(11);
    // Same mtime, different content: the cache is trusted (that is what a cache is).
    writeFileSync(f, HEAD + dev('h', 'h') + th('h', 'gpuUtil', 'kpred:yellow 22'));
    utimesSync(f, new Date(5_000_000), new Date(5_000_000));
    expect(loadDeviceConfig(root, 'h').thresholds.gpuUtil.yellow).toBe(11);
    // A new mtime invalidates it.
    utimesSync(f, new Date(6_000_000), new Date(6_000_000));
    expect(loadDeviceConfig(root, 'h').thresholds.gpuUtil.yellow).toBe(22);
  });
  it('a syntax error in device.ttl falls back to the defaults instead of throwing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    writeFileSync(process.env.RECKONS_DEVICE_TTL!, 'this is not turtle <<<');
    expect(loadDeviceConfig(dir, 'h').thresholds.gpuUtil).toEqual({ yellow: 85, red: 98 });
  });
});

describe('migration from watch.json', () => {
  it('prints equivalent TTL that resolves to the same numbers', () => {
    const ttl = legacyWatchToTurtle({ gpuUtil: { yellow: 70 }, vramPct: { red: 99 }, gpuStart: { tempC: 78 }, junk: 1 }, 'My Box');
    const r = resolveThresholds([defaults, ttl], 'My Box');
    expect(r.gpuUtil).toEqual({ yellow: 70, red: 98 });
    expect(r.vramPct).toEqual({ yellow: 85, red: 99 });
    expect(mergeGpuLimits(r).tempC).toBe(78);
    expect(resolveThresholds([defaults, ttl], 'other').gpuUtil.yellow).toBe(85);
  });
});
