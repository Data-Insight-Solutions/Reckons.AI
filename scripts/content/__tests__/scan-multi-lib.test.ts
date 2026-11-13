import { describe, expect, it } from 'vitest';
import { captureNames, captureOfFrame, chooseMatcher, EXHAUSTIVE_MAX_FRAMES, frameName, judgeJoin, parseCapture, parseMultiArgs, validateMulti } from '../scan-multi-lib.js';

const names = (cap: string, n: number) => Array.from({ length: n }, (_, i) => frameName(cap, i + 1));

describe('parseMultiArgs', () => {
  it('collects repeated captures and defaults', () => {
    const a = parseMultiArgs(['--capture', 'a.mov', '--capture=b.mov@0-27', '--out', 'o']);
    expect(a.captures.map((c) => c.path)).toEqual(['a.mov', 'b.mov']);
    expect(a.captures[1]).toMatchObject({ fromS: 0, toS: 27 });
    expect(a.keyframesPerCapture).toBe(100);
    expect(a.steps).toBe(30000);
  });
  it('refuses one capture, a missing out, bad counts and unknown options', () => {
    expect(() => parseMultiArgs(['--capture', 'a', '--out', 'o'])).toThrow(/at least 2/);
    expect(() => parseMultiArgs(['--capture', 'a', '--capture', 'b'])).toThrow(/--out/);
    expect(() => parseMultiArgs(['--capture', 'a', '--capture', 'b', '--out', 'o', '--keyframes-per-capture', '3'])).toThrow(/at least 10/);
    expect(() => parseMultiArgs(['--capture', 'a', '--capture', 'b', '--out', 'o', '--wat'])).toThrow(/unknown option/);
    expect(() => parseMultiArgs(['a', 'b'])).toThrow(/--capture/);
  });
  it('rejects a reversed slice', () => expect(() => parseCapture('v.mov@30-10')).toThrow(/after start/));
});

describe('frame naming and pooling', () => {
  it('names are unique, sortable per capture, and round-trip', () => {
    expect(captureNames([{ raw: '', path: '/x/Ring A.MOV' }, { raw: '', path: '/y/ring-a.mov' }, { raw: '', path: '/z/frames/' }])).toEqual(['ring-a', 'ring-a-2', 'frames']);
    expect(frameName('ring-a', 7)).toBe('ring-a__00007.jpg');
    expect(captureOfFrame('ring-a__00007.jpg')).toBe('ring-a');
    expect(() => captureOfFrame('plain.jpg')).toThrow();
    const pool = [...names('b', 3), ...names('a', 3)].sort();
    expect(pool.slice(0, 3).every((n) => captureOfFrame(n) === 'a')).toBe(true);
  });
});

describe('chooseMatcher', () => {
  it('matches every pair for a small pool', () => expect(chooseMatcher(200, undefined).matcher).toBe('exhaustive'));
  it('uses the limit inclusively', () => expect(chooseMatcher(EXHAUSTIVE_MAX_FRAMES, undefined).matcher).toBe('exhaustive'));
  it('needs a vocabulary tree above the limit and says so', () => {
    expect(() => chooseMatcher(EXHAUSTIVE_MAX_FRAMES + 1, undefined)).toThrow(/RECKONS_COLMAP_VOCAB_TREE/);
    expect(chooseMatcher(900, '/v.bin')).toMatchObject({ matcher: 'sequential-loop' });
  });
});

describe('judgeJoin', () => {
  const supplied = { a: 50, b: 50 };
  it('counts each capture in the one model', () => {
    const v = judgeJoin(supplied, { models: [[...names('a', 48), ...names('b', 45)]] });
    expect(v.singleModel).toBe(true);
    expect(v.captures.map((c) => [c.name, c.registered])).toEqual([['a', 48], ['b', 45]]);
    expect(v.failures).toEqual([]);
  });
  it('FAILS naming the capture that landed in another sub-model', () => {
    const v = judgeJoin(supplied, { models: [names('b', 12), [...names('a', 49), ...names('b', 30)], names('b', 1)] });
    expect(v.singleModel).toBe(true); // b has 30 in the largest
    const split = judgeJoin(supplied, { models: [names('a', 49), names('b', 40)] });
    expect(split.singleModel).toBe(false);
    expect(split.failures).toEqual(['capture "b" did not join the model: 0 of 50 frames registered in the largest model (40 more landed in a separate sub-model)']);
    expect(split.modelsFound).toBe(2);
  });
  it('treats a capture with almost nothing registered as not joined, and no model at all as failure', () => {
    expect(judgeJoin(supplied, { models: [[...names('a', 50), ...names('b', 3)]] }).failures[0]).toMatch(/"b"/);
    expect(judgeJoin(supplied, { models: [] }).singleModel).toBe(false);
  });
});

describe('validateMulti', () => {
  const v = judgeJoin({ a: 20, b: 20 }, { models: [[...names('a', 18), ...names('b', 15)]] });
  const rec = { matcher: 'exhaustive' as const, matcherReason: 'r', modelsFound: v.modelsFound, singleModel: v.singleModel, captures: v.captures.map((c) => ({ ...c, source: 's', keyframes: c.supplied, camera: 'SIMPLE_RADIAL' })) };
  it('accepts consistent accounting', () => expect(validateMulti(rec, 40, 33)).toEqual([]));
  it('rejects totals that do not add up and captures that did not join', () => {
    expect(validateMulti(rec, 41, 33).join()).toMatch(/supplied/);
    expect(validateMulti(rec, 40, 30).join()).toMatch(/registered counts/);
    expect(validateMulti({ ...rec, singleModel: false, captures: rec.captures.map((c) => ({ ...c, joined: false })) }, 40, 33).join()).toMatch(/did not join/);
  });
});
