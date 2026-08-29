import { describe, expect, it } from 'vitest';
import {
  clipFrozenSpans,
  interactionIsBlocking,
  performanceRunIsBlocking,
} from '../perf-interactions';

describe('interactionIsBlocking', () => {
  const quick = { settleMs: 50, longTasks: [] };

  it('keeps a genuinely quick interaction green', () => {
    expect(interactionIsBlocking(quick, 1_200)).toBe(false);
  });

  it('fails the run for budget overruns, measurement errors, and long tasks', () => {
    expect(interactionIsBlocking({ ...quick, settleMs: 1_200 }, 1_200)).toBe(true);
    expect(interactionIsBlocking({ ...quick, error: 'probe failed' }, 1_200)).toBe(true);
    expect(interactionIsBlocking({ ...quick, longTasks: [{ duration: 250 }] }, 1_200)).toBe(true);
  });
});

describe('performanceRunIsBlocking', () => {
  it('fails for either a page regression or a broken measurement harness', () => {
    expect(performanceRunIsBlocking([{ failures: ['slow'], harnessError: null }])).toBe(true);
    expect(performanceRunIsBlocking([{ failures: [], harnessError: 'capture failed' }])).toBe(true);
  });

  it('keeps a completely measured, failure-free run green', () => {
    expect(performanceRunIsBlocking([{ failures: [], harnessError: null }])).toBe(false);
  });
});

describe('clipFrozenSpans', () => {
  it('clips a still-frame run to the interaction pending window', () => {
    expect(clipFrozenSpans(
      [{ fromSec: 0, toSec: 8, frames: 33 }],
      2,
      5,
      1,
      4,
    )).toEqual([{ fromSec: 2, toSec: 5, frames: 13 }]);
  });

  it('drops stillness outside the pending window and clipped runs shorter than the threshold', () => {
    expect(clipFrozenSpans([
      { fromSec: 0, toSec: 2.5, frames: 11 },
      { fromSec: 3.2, toSec: 8, frames: 20 },
    ], 2, 3, 1, 4)).toEqual([]);
  });
});
