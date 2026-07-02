import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ollamaReachable, preferLocalBackend, preferLocalBackendSync, resetOllamaProbeCache } from '../prefer-local';

const okResponse = { ok: true } as Response;
const failResponse = { ok: false } as Response;

describe('prefer-local routing', () => {
  beforeEach(() => {
    resetOllamaProbeCache();
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns undefined when preferLocal is off, without probing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await preferLocalBackend({ preferLocal: false, ollamaBaseUrl: 'http://localhost:11434' }, undefined);
    expect(r).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never overrides an explicit per-task backend', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
    const r = await preferLocalBackend({ preferLocal: true, ollamaBaseUrl: 'http://localhost:11434' }, 'claude');
    expect(r).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('routes to ollama when on and reachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
    const r = await preferLocalBackend({ preferLocal: true, ollamaBaseUrl: 'http://localhost:11434' }, undefined);
    expect(r).toBe('ollama');
  });

  it('falls through when the probe fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await preferLocalBackend({ preferLocal: true, ollamaBaseUrl: 'http://localhost:11434' }, undefined);
    expect(r).toBeUndefined();
  });

  it('falls through on a non-ok probe response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(failResponse);
    const r = await preferLocalBackend({ preferLocal: true, ollamaBaseUrl: 'http://localhost:11434' }, undefined);
    expect(r).toBeUndefined();
  });

  it('caches the probe result within the TTL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
    await ollamaReachable('http://localhost:11434');
    await ollamaReachable('http://localhost:11434');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-probes when the base URL changes', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
    await ollamaReachable('http://localhost:11434');
    await ollamaReachable('http://192.168.1.10:11434');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('probes /api/tags on the normalized base URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
    await ollamaReachable('http://localhost:11434/');
    expect(fetchSpy).toHaveBeenCalledWith('http://localhost:11434/api/tags', expect.anything());
  });

  it('sync variant returns undefined on a cold cache but warms it in the background', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse);
    const s = { preferLocal: true, ollamaBaseUrl: 'http://localhost:11434' };
    expect(preferLocalBackendSync(s, undefined)).toBeUndefined();
    // Let the background probe settle, then the cached value routes.
    await ollamaReachable(s.ollamaBaseUrl);
    expect(preferLocalBackendSync(s, undefined)).toBe('ollama');
  });

  it('sync variant respects explicit overrides and the off switch', () => {
    expect(preferLocalBackendSync({ preferLocal: true, ollamaBaseUrl: 'x' }, 'wasm')).toBeUndefined();
    expect(preferLocalBackendSync({ preferLocal: false, ollamaBaseUrl: 'x' }, undefined)).toBeUndefined();
  });
});
