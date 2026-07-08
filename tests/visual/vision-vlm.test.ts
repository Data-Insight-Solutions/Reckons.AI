import { describe, it, expect, vi, afterEach } from 'vitest';

// vision-vlm reads OLLAMA_BASE_URL at module load, so tests reset+re-import.
describe('vision-vlm (local VLM review)', () => {
  const OLD = process.env.OLLAMA_BASE_URL;
  afterEach(() => {
    if (OLD === undefined) delete process.env.OLLAMA_BASE_URL;
    else process.env.OLLAMA_BASE_URL = OLD;
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('hasOllamaVlm is opt-in via OLLAMA_BASE_URL', async () => {
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.VITE_OLLAMA_BASE_URL;
    vi.resetModules();
    let m = await import('./vision-vlm');
    expect(m.hasOllamaVlm()).toBe(false);

    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    vi.resetModules();
    m = await import('./vision-vlm');
    expect(m.hasOllamaVlm()).toBe(true);
  });

  it('vlmGate treats a leading YES as pass and keeps the reason', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    vi.resetModules();
    const m = await import('./vision-vlm');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: 'YES\nThe bottom sheet with title and close is visible.' }),
    })));
    const r = await m.vlmGate('ZmFrZQ==', 'Is a bottom sheet visible?');
    expect(r.pass).toBe(true);
    expect(r.notes).toContain('bottom sheet');
  });

  it('vlmGate treats a leading NO as fail', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    vi.resetModules();
    const m = await import('./vision-vlm');
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ response: 'NO — the panel is missing.' }),
    })));
    const r = await m.vlmGate('ZmFrZQ==', 'Is a bottom sheet visible?');
    expect(r.pass).toBe(false);
  });

  it('reviewImageVLM sends the image + model to Ollama /api/generate', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    vi.resetModules();
    const m = await import('./vision-vlm');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ response: 'ok' }) }));
    vi.stubGlobal('fetch', fetchMock);
    await m.reviewImageVLM('ZmFrZQ==', 'describe this', 'qwen2.5vl:7b');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/generate');
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('qwen2.5vl:7b');
    expect(body.images).toEqual(['ZmFrZQ==']);
    expect(body.stream).toBe(false);
  });
});
