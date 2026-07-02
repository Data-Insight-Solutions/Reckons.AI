import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

/** Re-import the module fresh so module-level env reads (OLLAMA_BASE_URL/MODEL) pick up test env changes. */
async function freshModule() {
  vi.resetModules();
  return import('../ollama-client.js');
}

describe('ollama-client', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is disabled when OLLAMA_BASE_URL is unset, and ollamaChat rejects with an actionable message', async () => {
    delete process.env.OLLAMA_BASE_URL;
    const mod = await freshModule();

    expect(mod.ollamaEnabled()).toBe(false);
    await expect(mod.ollamaChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/OLLAMA_BASE_URL/);
    expect(mod.OLLAMA_DISABLED_MESSAGE).toMatch(/OLLAMA_BASE_URL/);
    expect(mod.OLLAMA_DISABLED_MESSAGE).toMatch(/http:\/\/localhost:11434/);
  });

  it('defaults OLLAMA_MODEL to devstral-small-2:latest when unset', async () => {
    delete process.env.OLLAMA_MODEL;
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const mod = await freshModule();
    expect(mod.OLLAMA_MODEL).toBe('devstral-small-2:latest');
  });

  it('is enabled once OLLAMA_BASE_URL is set and posts to /api/chat with stream:false', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    process.env.OLLAMA_MODEL = 'llama3.2:3b';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'hello there' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const mod = await freshModule();
    expect(mod.ollamaEnabled()).toBe(true);

    const result = await mod.ollamaChat([{ role: 'user', content: 'hi' }]);

    expect(result).toBe('hello there');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/chat');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('llama3.2:3b');
    expect(body.stream).toBe(false);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('strips a trailing slash from OLLAMA_BASE_URL', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434/';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: 'ok' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    await mod.ollamaChat([{ role: 'user', content: 'hi' }]);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
  });

  it('throws with status details on a non-ok response', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();
    await expect(mod.ollamaChat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/);
  });

  it('ollamaChatJSON parses valid JSON on the first try, sending the format schema', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: '{"ok":true}' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();

    const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const result = await mod.ollamaChatJSON<{ ok: boolean }>([{ role: 'user', content: 'hi' }], schema);

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.format).toEqual(schema);
  });

  it('ollamaChatJSON retries once on invalid JSON, appending the parse error to the conversation', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: 'not json at all' } }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ message: { content: '{"ok":true}' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();

    const result = await mod.ollamaChatJSON<{ ok: boolean }>([{ role: 'user', content: 'hi' }], { type: 'object' });

    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body);
    const lastMsg = secondBody.messages[secondBody.messages.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(lastMsg.content).toMatch(/not valid JSON/i);
    // The original bad assistant reply should also be included so the model has full context.
    expect(secondBody.messages.some((m: { content: string }) => m.content === 'not json at all')).toBe(true);
  });

  it('ollamaChatJSON propagates the parse error when the retry also fails', async () => {
    process.env.OLLAMA_BASE_URL = 'http://localhost:11434';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: { content: 'still not json' } }) });
    vi.stubGlobal('fetch', fetchMock);
    const mod = await freshModule();

    await expect(mod.ollamaChatJSON([{ role: 'user', content: 'hi' }], { type: 'object' })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
