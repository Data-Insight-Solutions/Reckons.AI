import { describe, expect, it } from 'vitest';
import type { GpuVerdict } from '../../../agent/session-gpu';
import { DEFAULT_WAIT_MIN, gpuStep, parseWaitMin, POLL_MS, waitForGpu } from '../gpu-wait';

const hot: GpuVerdict = { ok: false, kind: 'hot', reason: 'GPU 1 at 89 C >= 83 C' };

describe('gpuStep', () => {
  it('runs on a clear GPU', () => expect(gpuStep({ ok: true }, 0, 1000)).toEqual({ act: 'run' }));
  it('waits on a hot GPU until the limit, then skips', () => {
    expect(gpuStep(hot, 999, 1000).act).toBe('wait');
    expect(gpuStep(hot, 1000, 1000).act).toBe('skip');
  });
  it('runs with a warning when GPU state is unknown (no nvidia-smi), unlike the worker', () => {
    expect(gpuStep({ ok: false, kind: 'unknown', reason: 'no smi' }, 0, 1000)).toEqual({ act: 'run-unknown', reason: 'no smi' });
  });
});

describe('waitForGpu', () => {
  it('waits through a hot reading and runs once the GPU cools, logging the reason once', async () => {
    const readings: GpuVerdict[] = [hot, hot, { ok: true }];
    const logs: string[] = [];
    let slept = 0;
    const step = await waitForGpu(async () => readings.shift()!, 60 * 60_000, (s) => logs.push(s), async (ms) => { slept += ms; });
    expect(step).toEqual({ act: 'run' });
    expect(slept).toBe(2 * POLL_MS);
    expect(logs).toEqual(['gpu gate: waiting (GPU 1 at 89 C >= 83 C)', 'gpu gate: clear']);
  });
  it('skips when the limit is zero and the GPU is hot', async () => {
    const step = await waitForGpu(async () => hot, 0, () => {}, async () => {});
    expect(step.act).toBe('skip');
  });
});

describe('parseWaitMin', () => {
  it('defaults, accepts zero and fractions', () => {
    expect(parseWaitMin(undefined)).toBe(DEFAULT_WAIT_MIN);
    expect(parseWaitMin('0')).toBe(0);
    expect(parseWaitMin('1.5')).toBe(1.5);
  });
  it('refuses what would make the wait endless or meaningless', () => {
    for (const bad of ['abc', '', '-1', 'Infinity']) expect(() => parseWaitMin(bad)).toThrow(/gpu-wait-min/);
  });
});
