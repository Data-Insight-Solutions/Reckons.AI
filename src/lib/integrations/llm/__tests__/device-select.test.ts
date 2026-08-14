/**
 * Execution-provider selection.
 *
 * The failure that actually hurts is not "we missed a GPU" — it is routing a user to a provider
 * that CANNOT RUN, leaving them with no inference at all. WebGPU is routinely present-but-unusable
 * (no adapter in headless/VMs, blocklisted drivers, or an adapter that fails when the pipeline
 * builds), so these tests pin that every one of those paths still ends on a working backend.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hasUsableWebGPU, pickDevice, loadWithDeviceFallback,
  type GpuCapableNavigator,
} from '../device-select';

const withAdapter = (): GpuCapableNavigator => ({ gpu: { requestAdapter: async () => ({}) } });
const noAdapter = (): GpuCapableNavigator => ({ gpu: { requestAdapter: async () => null } });
const throwingAdapter = (): GpuCapableNavigator => ({
  gpu: { requestAdapter: async () => { throw new Error('driver blocklisted'); } },
});
const noGpuApi = (): GpuCapableNavigator => ({});

beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('hasUsableWebGPU', () => {
  it('is true only when a real adapter comes back', async () => {
    expect(await hasUsableWebGPU(withAdapter())).toBe(true);
  });

  it('is false when the API exists but no adapter does — the headless/VM case', async () => {
    // `'gpu' in navigator` would say YES here. That is the trap this function exists to avoid.
    expect(await hasUsableWebGPU(noAdapter())).toBe(false);
  });

  it('is false when requesting an adapter throws, and does not propagate', async () => {
    await expect(hasUsableWebGPU(throwingAdapter())).resolves.toBe(false);
  });

  it('is false when the browser has no WebGPU at all', async () => {
    expect(await hasUsableWebGPU(noGpuApi())).toBe(false);
  });

  it('is false under SSR, where there is no navigator', async () => {
    expect(await hasUsableWebGPU(undefined)).toBe(false);
  });
});

describe('pickDevice', () => {
  it('prefers webgpu when it is genuinely usable', async () => {
    expect(await pickDevice(withAdapter())).toBe('webgpu');
  });

  it('falls to wasm whenever webgpu is not usable', async () => {
    expect(await pickDevice(noAdapter())).toBe('wasm');
    expect(await pickDevice(noGpuApi())).toBe('wasm');
  });
});

describe('loadWithDeviceFallback', () => {
  it('builds on webgpu when available, and reports that', async () => {
    const build = vi.fn(async (d: string) => `pipeline-${d}`);
    const r = await loadWithDeviceFallback(build, withAdapter());
    expect(r.device).toBe('webgpu');
    expect(r.value).toBe('pipeline-webgpu');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('does not even attempt webgpu when no adapter exists', async () => {
    const build = vi.fn(async (d: string) => `pipeline-${d}`);
    const r = await loadWithDeviceFallback(build, noAdapter());
    expect(r.device).toBe('wasm');
    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith('wasm');
  });

  it('RETRIES on wasm when webgpu is present but fails to build', async () => {
    // The important case: the adapter exists, so detection says yes, and construction still blows
    // up (unsupported op, OOM, driver fault). The user must still get a working model.
    const build = vi.fn(async (d: string) => {
      if (d === 'webgpu') throw new Error('unsupported op on this adapter');
      return 'pipeline-wasm';
    });
    const r = await loadWithDeviceFallback(build, withAdapter());
    expect(r.device).toBe('wasm');
    expect(r.value).toBe('pipeline-wasm');
    expect(build).toHaveBeenCalledTimes(2);
    expect(r.fallbackReason).toMatch(/unsupported op/);
  });

  it('reports the device that SUCCEEDED, never the one it hoped for', async () => {
    const build = async (d: string) => {
      if (d === 'webgpu') throw new Error('nope');
      return 'ok';
    };
    // Claiming webgpu while running on wasm is the exact dishonesty this replaces.
    expect((await loadWithDeviceFallback(build, withAdapter())).device).toBe('wasm');
  });

  it('warns loudly on fallback so a silent slowdown is never a mystery', async () => {
    const warn = vi.spyOn(console, 'warn');
    const build = async (d: string) => {
      if (d === 'webgpu') throw new Error('driver fault');
      return 'ok';
    };
    await loadWithDeviceFallback(build, withAdapter());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('WebGPU failed'), expect.stringContaining('driver fault'));
  });

  it('propagates a WASM failure — there is nothing left to fall back to', async () => {
    const build = async () => { throw new Error('wasm broke too'); };
    await expect(loadWithDeviceFallback(build, noAdapter())).rejects.toThrow(/wasm broke too/);
  });
});
