import { describe, it, expect } from 'vitest';
import { parseGraphDate } from '../parse-date';

/** Local calendar parts of a timestamp — what the user actually sees on a timeline. */
function localParts(ts: number) {
  const d = new Date(ts);
  return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

describe('parseGraphDate — timeline placement (node lands on the day it names)', () => {
  it('places a date-only value on THAT calendar day, not the day before', () => {
    // The bug this pins: `new Date('2026-07-15')` is UTC midnight, which is 14 July local
    // anywhere west of Greenwich — the node rendered on the wrong day.
    expect(localParts(parseGraphDate('2026-07-15')!)).toEqual({ y: 2026, m: 7, d: 15 });
    expect(localParts(parseGraphDate('2026-01-01')!)).toEqual({ y: 2026, m: 1, d: 1 });
    expect(localParts(parseGraphDate('2026-12-31')!)).toEqual({ y: 2026, m: 12, d: 31 });
  });

  it('keeps a date-only and a same-day datetime on the same day (no timezone skew between them)', () => {
    const dateOnly = parseGraphDate('2026-07-15')!;
    const sameDay = parseGraphDate('2026-07-15T10:30:00')!;
    expect(localParts(dateOnly)).toEqual(localParts(sameDay));
    // ...and ordered correctly within the day.
    expect(sameDay).toBeGreaterThan(dateOnly);
  });

  it('anchors partial dates to the start of their period', () => {
    expect(localParts(parseGraphDate('2026-07')!)).toEqual({ y: 2026, m: 7, d: 1 });
    expect(localParts(parseGraphDate('2026')!)).toEqual({ y: 2026, m: 1, d: 1 });
  });

  it('honours an explicit timezone as an absolute instant', () => {
    expect(parseGraphDate('2026-07-15T00:00:00Z')).toBe(Date.parse('2026-07-15T00:00:00Z'));
    expect(parseGraphDate('2026-07-15T12:00:00+02:00')).toBe(Date.parse('2026-07-15T12:00:00+02:00'));
  });

  it('accepts epoch seconds and milliseconds', () => {
    const ms = 1_784_000_000_000;
    expect(parseGraphDate(ms)).toBe(ms);
    expect(parseGraphDate(String(ms))).toBe(ms);
    expect(parseGraphDate(1_784_000_000)).toBe(ms); // seconds → ms
  });

  it('orders a real sequence of mixed-format dates correctly', () => {
    const seq = ['2024', '2025-06', '2026-07-15', '2026-07-15T18:00:00'].map((v) => parseGraphDate(v)!);
    expect(seq.every((n) => typeof n === 'number')).toBe(true);
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
  });

  it('returns undefined rather than guessing a position', () => {
    for (const bad of ['', '   ', 'someday', 'not a date', '2026-13-01', '2026-07-45', null, undefined, {}]) {
      expect(parseGraphDate(bad as unknown), String(bad)).toBeUndefined();
    }
  });

  it('rejects dates that do not exist instead of silently rolling them over', () => {
    // `new Date(2026, 1, 30)` does not fail — it becomes 2 March. A range check alone would
    // place an impossible date two days from where it claims to be.
    for (const impossible of ['2026-02-30', '2026-02-29', '2026-04-31', '2026-06-31', '2026-11-31']) {
      expect(parseGraphDate(impossible), impossible).toBeUndefined();
    }
  });

  it('still accepts a real leap day', () => {
    expect(localParts(parseGraphDate('2024-02-29')!)).toEqual({ y: 2024, m: 2, d: 29 });
  });
});
