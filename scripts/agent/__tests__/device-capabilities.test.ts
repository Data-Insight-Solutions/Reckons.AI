import { describe, expect, it } from 'vitest';
import { Parser } from 'n3';
import { iriTerm, matchCapabilities, measurementsToValues, readMeasuredSpace, termIri, type Measured } from '../device-capabilities';
import { buildMeasuredSpaceText } from '../device-space-build';
import { parseGpuMemory, parseMemAvailable, parseModelNames } from '../measure-device';

// SYNTHETIC records only: no value here describes a real machine.
const RAW = {
  measuredAt: '2030-01-02T03:04:05.000Z',
  ramTotalBytes: 32 * 1024 ** 3,
  ramAvailableBytes: 20 * 1024 ** 3,
  gpuMemoryMiB: [8192, 24576],
  diskFreeBytes: 500 * 1024 ** 3,
  models: ['Alpha-Model:7b', 'beta'],
  tools: { widget: true, gizmo: false },
};
const ID = '11111111-2222-4333-8444-555555555555';

describe('measurementsToValues', () => {
  it('turns raw probes into capability terms', () => {
    const m = measurementsToValues(RAW);
    expect(m.values['ram-gib']).toBe(32);
    expect(m.values['ram-available-gib']).toBe(20);
    expect(m.values['gpu-count']).toBe(2);
    expect(m.values['gpu-memory-gib']).toBe(24);
    expect(m.values['gpu-memory-total-gib']).toBe(32);
    expect(m.values['disk-free-gib']).toBe(500);
    expect(m.values['model:alpha-model:7b']).toBe(true);
    expect(m.values['tool:widget']).toBe(true);
    expect(m.values['tool:gizmo']).toBe(false);
  });
  it('leaves a probe that could not run unmeasured, not zero', () => {
    const m = measurementsToValues({ measuredAt: RAW.measuredAt, ramTotalBytes: 1024 ** 3 });
    expect(Object.keys(m.values)).toEqual(['ram-gib']);
  });
  it('a device with no GPU measures a count of zero', () => {
    const m = measurementsToValues({ measuredAt: RAW.measuredAt, gpuMemoryMiB: [] });
    expect(m.values['gpu-count']).toBe(0);
    expect(m.values['gpu-memory-gib']).toBe(0);
  });
});

describe('term IRIs', () => {
  it('round-trip, including a model tag with a colon', () => {
    for (const t of ['ram-gib', 'tool:widget', 'model:alpha-model:7b']) expect(iriTerm(termIri(t))).toBe(t);
  });
  it('rejects an IRI outside the capability namespace', () => expect(iriTerm('urn:other/x')).toBeUndefined());
});

describe('the device space text', () => {
  const m = measurementsToValues(RAW);
  const text = buildMeasuredSpaceText(m, ID, 0);
  it('parses and is marked device-only with the given stable id', () => {
    expect(() => new Parser().parse(text)).not.toThrow();
    expect(text).toContain(`"${ID}"`);
    expect(text).toContain('urn:reckons:meta/deviceOnly');
  });
  it('carries no host name or user name field', () => {
    expect(text).not.toMatch(/hostname|username/i);
  });
  it('reads back to the same values and date', () => {
    expect(readMeasuredSpace(text)).toEqual(m);
  });
  it('is deterministic apart from the generated line', () => {
    const strip = (t: string) => t.split('\n').filter((l) => !l.startsWith('# generated')).join('\n');
    expect(strip(buildMeasuredSpaceText(m, ID, 1))).toBe(strip(buildMeasuredSpaceText(m, ID, 99999)));
  });
  it('the reader rejects text that does not parse', () => {
    expect(() => readMeasuredSpace('this is not turtle')).toThrow();
  });
});

describe('matchCapabilities', () => {
  const m: Measured = measurementsToValues(RAW);
  it('can-run when every need is met', () => {
    expect(matchCapabilities([{ term: 'gpu-memory-gib', atLeast: 12 }, { term: 'tool:widget' }, { term: 'model:beta' }], m)).toEqual({ verdict: 'can-run' });
  });
  it('can-run with no needs', () => expect(matchCapabilities([], m).verdict).toBe('can-run'));
  it('says how far short a numeric need falls', () => {
    const r = matchCapabilities([{ term: 'ram-gib', atLeast: 64 }], m);
    expect(r).toEqual({ verdict: 'cannot-run', reasons: ['ram-gib: needs at least 64, measured 32'] });
  });
  it('separates measured absent from never measured', () => {
    const r = matchCapabilities([{ term: 'tool:gizmo' }, { term: 'tool:unknown' }], m);
    expect(r).toEqual({ verdict: 'cannot-run', reasons: ['tool:gizmo: measured absent', 'tool:unknown: not measured on this device'] });
  });
  it('claims nothing without a measurement at all', () => {
    expect(matchCapabilities([{ term: 'ram-gib', atLeast: 1 }], undefined).verdict).toBe('cannot-run');
  });
  it('a presence need on a zero count is not met', () => {
    const none = measurementsToValues({ measuredAt: RAW.measuredAt, gpuMemoryMiB: [] });
    expect(matchCapabilities([{ term: 'gpu-count' }], none).verdict).toBe('cannot-run');
  });
  it('reports every unmet need, not only the first', () => {
    const r = matchCapabilities([{ term: 'ram-gib', atLeast: 999 }, { term: 'tool:gizmo' }], m);
    expect(r.verdict === 'cannot-run' && r.reasons.length).toBe(2);
  });
});

describe('probe parsers', () => {
  it('reads MemAvailable', () => expect(parseMemAvailable('MemTotal: 10 kB\nMemAvailable:    2048 kB\n')).toBe(2048 * 1024));
  it('MemAvailable absent is undefined', () => expect(parseMemAvailable('MemTotal: 10 kB')).toBeUndefined());
  it('reads one number per GPU line and skips junk', () => expect(parseGpuMemory('8192\n24576\nN/A\n')).toEqual([8192, 24576]));
  it('reads model names, or undefined for a body that is not a model list', () => {
    expect(parseModelNames({ models: [{ name: 'a' }, { name: 'b:1' }, {}] })).toEqual(['a', 'b:1']);
    expect(parseModelNames({ error: 'x' })).toBeUndefined();
  });
});
