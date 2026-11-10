import { describe, expect, it } from 'vitest';
import { DEFAULT_GPU_LIMITS, gpuVerdict, type ComputeApp, type Gpu } from '../session-gpu';
import { newJob, serializeQueue } from '../session-queue';

/**
 * GPU PINNING (Matt, 2026-11-10): a job bound to a physical GPU is judged on THAT GPU only, so a
 * co-tenant legitimately heating another one (the deputy's own Ollama runtime on GPU0) does not hold
 * it — unpinned jobs keep the all-GPU check, and the foreign-VRAM guard stays global.
 */
const hot = (i: number): Gpu => ({ index: i, util: 98, usedMiB: 18032, totalMiB: 24576, tempC: 93 });
const cool = (i: number): Gpu => ({ index: i, util: 9, usedMiB: 2532, totalMiB: 24576, tempC: 64 });
const ollama: ComputeApp = { pid: 1, name: 'ollama_llama_server', usedMiB: 18032 };
const foreign: ComputeApp = { pid: 2, name: 'webodm', usedMiB: 5120 };

describe('gpuVerdict with a pinned GPU', () => {
  it('passes when the OTHER gpu is the hot one (the deputy-heats-GPU0 case)', () => {
    const gpus = [hot(0), cool(1)];
    expect(gpuVerdict(gpus, [ollama], DEFAULT_GPU_LIMITS, 1)).toEqual({ ok: true });
    // …and the same board blocks an unpinned job and a job pinned to the hot GPU (fail safe kept).
    expect(gpuVerdict(gpus, [ollama], DEFAULT_GPU_LIMITS).ok).toBe(false);
    expect(gpuVerdict(gpus, [ollama], DEFAULT_GPU_LIMITS, 0).ok).toBe(false);
  });

  it('still blocks when the pinned gpu itself is hot, full or busy', () => {
    expect(gpuVerdict([cool(0), hot(1)], [ollama], DEFAULT_GPU_LIMITS, 1).kind).toBe('hot');
    const full: Gpu = { index: 1, util: 9, usedMiB: 24000, totalMiB: 24576, tempC: 64 };
    expect(gpuVerdict([cool(0), full], [ollama], DEFAULT_GPU_LIMITS, 1).kind).toBe('full');
    const busy: Gpu = { index: 1, util: 91, usedMiB: 2532, totalMiB: 24576, tempC: 64 };
    expect(gpuVerdict([cool(0), busy], [foreign], DEFAULT_GPU_LIMITS, 1).kind).toBe('busy');
  });

  it('keeps the foreign-VRAM guard global even for a pinned job (2026-10-01 crash protection)', () => {
    const gpus = [hot(0), cool(1)];
    expect(gpuVerdict(gpus, [foreign], DEFAULT_GPU_LIMITS, 1).kind).toBe('busy');
  });

  it('fails closed when the pinned gpu is not present, and when telemetry is missing', () => {
    expect(gpuVerdict([hot(0), cool(1)], [ollama], DEFAULT_GPU_LIMITS, 9).kind).toBe('unknown');
    expect(gpuVerdict(null, null, DEFAULT_GPU_LIMITS, 1).kind).toBe('unknown');
  });

  it('still exempts Ollama-only load on the pinned gpu itself (existing semantics)', () => {
    const mine: Gpu = { index: 1, util: 98, usedMiB: 15000, totalMiB: 24576, tempC: 70 };
    expect(gpuVerdict([cool(0), mine], [ollama], DEFAULT_GPU_LIMITS, 1)).toEqual({ ok: true });
  });
});

describe('queue job gpuIndex round-trip', () => {
  it('newJob carries gpuIndex and serializeQueue keeps it', () => {
    const j = newJob('scan', '/w', ['a'], 6, undefined, undefined, false, undefined, 1);
    expect(j.gpuIndex).toBe(1);
    const round = JSON.parse(serializeQueue([j]).trim().split('\n')[0]);
    expect(round.gpuIndex).toBe(1);
    const plain = JSON.parse(serializeQueue([newJob('scan', '/w', ['a'])]).trim().split('\n')[0]);
    expect(plain.gpuIndex).toBeUndefined();
  });
});
