import { describe, expect, it } from 'vitest';
import { laplacianVariance, median, roiBox, selectKeyframes, signatureDistance, trackAt, windowOf, type Scored } from '../keyframe-select-lib.js';

/** Synthetic checker, optionally box-blurred: a stand-in for a crisp or soft crop. Never a real frame. */
function checker(n: number, cell: number, blur = 0): number[] {
  let g = Array.from({ length: n * n }, (_, i) => (((i % n) / cell | 0) + ((i / n | 0) / cell | 0)) % 2 ? 255 : 0);
  for (let p = 0; p < blur; p++) {
    const o = g.slice();
    for (let y = 1; y < n - 1; y++) for (let x = 1; x < n - 1; x++) {
      const i = y * n + x;
      o[i] = (g[i] + g[i - 1] + g[i + 1] + g[i - n] + g[i + n]) / 5;
    }
    g = o;
  }
  return g;
}

describe('laplacianVariance', () => {
  it('is zero on a flat image and ranks crisp above blurred above flat', () => {
    expect(laplacianVariance(new Array(64).fill(100), 8, 8)).toBe(0);
    const crisp = laplacianVariance(checker(32, 4), 32, 32);
    const soft = laplacianVariance(checker(32, 4, 2), 32, 32);
    expect(crisp).toBeGreaterThan(soft);
    expect(soft).toBeGreaterThan(0);
  });
});

describe('trackAt / roiBox / windowOf', () => {
  const tr = [{ t: 0, x: 0.2, y: 0.4 }, { t: 10, x: 0.6, y: 0.2 }];
  it('interpolates and clamps', () => {
    expect(trackAt(tr, 5)).toEqual({ x: 0.4, y: expect.closeTo(0.3, 9) });
    expect(trackAt(tr, -1)).toEqual({ x: 0.2, y: 0.4 });
    expect(trackAt(tr, 99)).toEqual({ x: 0.6, y: 0.2 });
    expect(() => trackAt([], 0)).toThrow();
  });
  it('keeps the box inside the frame', () => {
    expect(roiBox(900, 1600, { cx: 0.5, cy: 0.5, size: 0.4 })).toEqual({ left: 270, top: 620, width: 360, height: 360 });
    const edge = roiBox(900, 1600, { cx: 0.99, cy: 0.01, size: 0.4 });
    expect(edge.left + edge.width).toBe(900);
    expect(edge.top).toBe(0);
  });
  it('maps times to windows', () => {
    expect(windowOf(0, 10, 5)).toBe(0);
    expect(windowOf(9.99, 10, 5)).toBe(4);
    expect(windowOf(10, 10, 5)).toBe(4);
  });
});

describe('signatureDistance', () => {
  it('ignores brightness shifts, sees structure', () => {
    const a = [0, 255, 0, 255];
    expect(signatureDistance(a, a.map((v) => v / 2 + 20))).toBeGreaterThan(0);
    expect(signatureDistance([10, 20, 30], [110, 120, 130])).toBe(0);
    expect(signatureDistance(a, [255, 0, 255, 0])).toBeGreaterThan(0.9);
    expect(() => signatureDistance([1], [1, 2])).toThrow();
  });
});

describe('selectKeyframes', () => {
  const sig = (k: number) => [k, 255 - k, k, 255 - k];
  const mk = (index: number, t: number, score: number, k: number): Scored => ({ index, t, score, signature: sig(k) });
  const opt = { windows: 4, duration: 4, floorRatio: 0.5, duplicateDistance: 0.05 };

  it('keeps the sharpest frame per window and says why the others lost', () => {
    const frames = [mk(0, 0.1, 100, 0), mk(1, 0.6, 300, 40), mk(2, 1.2, 280, 90), mk(3, 1.7, 200, 130), mk(4, 2.5, 250, 170), mk(5, 3.5, 260, 210)];
    const { decisions } = selectKeyframes(frames, opt);
    const by = Object.fromEntries(decisions.map((d) => [d.index, d]));
    expect(decisions.filter((d) => d.kept).map((d) => d.index)).toEqual([1, 2, 4, 5]);
    expect(by[0].reason).toBe('below-floor'); // 100 < 0.5 x median(230)
    expect(by[3].reason).toBe('not-best-in-window');
  });

  it('refuses a near-duplicate of the previous kept frame and falls back to the next best', () => {
    const frames = [mk(0, 0.5, 300, 50), mk(1, 1.5, 310, 50), mk(2, 1.6, 290, 160), mk(3, 2.5, 280, 100), mk(4, 3.5, 270, 220)];
    const { decisions } = selectKeyframes(frames, opt);
    const by = Object.fromEntries(decisions.map((d) => [d.index, d]));
    expect(by[1].reason).toBe('near-duplicate');
    expect(by[2].kept).toBe(true);
  });

  it('reports a window where every frame is blurred as a gap, not a blurred keeper', () => {
    const frames = [mk(0, 0.5, 300, 0), mk(1, 1.5, 10, 60), mk(2, 2.5, 300, 120), mk(3, 3.5, 300, 180)];
    const { decisions, emptyWindows } = selectKeyframes(frames, opt);
    expect(emptyWindows).toEqual([1]);
    expect(decisions.find((d) => d.index === 1)!.kept).toBe(false);
  });

  it('median', () => { expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(2.5); expect(median([])).toBe(0); });
});
