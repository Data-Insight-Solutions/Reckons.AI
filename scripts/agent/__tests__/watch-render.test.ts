import { describe, expect, it } from 'vitest';
import { attemptLevel, banner, classify, DEFAULT_THRESHOLDS, elapsedLevel, fitArt, median, mergeThresholds, turtle, TURTLE_FRAMES, worst } from '../watch-render.js';

describe('classify', () => {
  const b = { yellow: 10, red: 20 };
  it('bands at the boundaries', () => {
    expect([9.9, 10, 19.9, 20].map((v) => classify(v, b))).toEqual(['ok', 'warn', 'warn', 'bad']);
  });
  it('unknown is not an alarm', () => {
    expect(classify(undefined, b)).toBe('ok');
    expect(classify(NaN, b)).toBe('ok');
  });
});

describe('attemptLevel', () => {
  it('yellow at max-1, red at max or an open circuit', () => {
    expect([1, 2, 3].map((a) => attemptLevel(a, 3))).toEqual(['ok', 'warn', 'bad']);
    expect(attemptLevel(1, 3, true)).toBe('bad');
    expect(attemptLevel(1, 1)).toBe('bad');
  });
});

describe('elapsedLevel', () => {
  it('compares to the job own median; no history is ok', () => {
    const b = DEFAULT_THRESHOLDS.jobElapsedRatio;
    expect(elapsedLevel(100, 100, b)).toBe('ok');
    expect(elapsedLevel(160, 100, b)).toBe('warn');
    expect(elapsedLevel(300, 100, b)).toBe('bad');
    expect(elapsedLevel(9e9, undefined, b)).toBe('ok');
  });
  it('median', () => {
    expect(median([])).toBeUndefined();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });
});

describe('thresholds config', () => {
  it('overrides per metric and ignores junk', () => {
    const t = mergeThresholds({ gpuUtil: { yellow: 50 }, vramPct: { red: 'x' }, nope: { yellow: 1 } });
    expect(t.gpuUtil).toEqual({ yellow: 50, red: DEFAULT_THRESHOLDS.gpuUtil.red });
    expect(t.vramPct).toEqual(DEFAULT_THRESHOLDS.vramPct);
    expect(DEFAULT_THRESHOLDS.gpuUtil.yellow).toBe(85); // defaults not mutated
    expect(mergeThresholds('garbage')).toEqual(DEFAULT_THRESHOLDS);
  });
  it('worst', () => {
    expect(worst([])).toBe('ok');
    expect(worst(['ok', 'warn'])).toBe('warn');
    expect(worst(['warn', 'bad', 'ok'])).toBe('bad');
  });
});

describe('art', () => {
  it('banner is 3 rows', () => expect(banner()).toHaveLength(3));
  it('turtle cycles and wraps, one frame per refresh', () => {
    const f = Array.from({ length: TURTLE_FRAMES }, (_, i) => turtle(i, 'ok').join('\n'));
    expect(new Set(f).size).toBe(TURTLE_FRAMES);
    expect(turtle(TURTLE_FRAMES, 'ok')).toEqual(turtle(0, 'ok'));
    expect(turtle(-1, 'ok')).toEqual(turtle(TURTLE_FRAMES - 1, 'ok'));
  });
  it('mood changes the face', () => {
    expect(new Set((['ok', 'warn', 'bad'] as const).map((m) => turtle(0, m)[1])).size).toBe(3);
  });
  it('rows are equal width', () => {
    for (let i = 0; i < 4; i++) expect(new Set(turtle(i, 'bad').map((r) => r.length)).size).toBe(1);
  });
  it('fits to width: both, banner only, none', () => {
    const both = fitArt(80, 0, 'ok');
    expect(both).toHaveLength(3);
    const bw = Math.max(...banner().map((r) => [...r].length));
    expect(fitArt(bw, 0, 'ok')).toEqual(banner());
    expect(fitArt(bw - 1, 0, 'ok')).toEqual([]);
    expect(fitArt(undefined, 0, 'ok')).toEqual([]);
    for (const r of both) expect([...r].length).toBeLessThanOrEqual(80);
  });
});
