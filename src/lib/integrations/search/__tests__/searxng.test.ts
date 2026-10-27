import { afterEach, describe, expect, it, vi } from 'vitest';
import { searxng, searchConfigurationError } from '../triple-check';
import type { SettingsRecord } from '$lib/storage/db';

afterEach(() => vi.unstubAllGlobals());

describe('SearXNG search (F100.7)', () => {
  it('asks the instance for JSON and keeps at most five well-formed results', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [
      { url: 'https://a.test/', title: 'A', content: 'passage a' }, { title: 'no url' }, { url: 'https://b.test/', title: 'B' },
      ...Array.from({ length: 6 }, (_, i) => ({ url: `https://c${i}.test/`, title: `C${i}`, content: '' })),
    ] })));
    vi.stubGlobal('fetch', fetchMock);
    const out = await searxng('http://localhost:8888', 'harbor 10 warranty', new AbortController().signal);
    const url = new URL(String((fetchMock.mock.calls[0] as unknown[])[0]));
    expect(url.pathname).toBe('/search'); expect(url.searchParams.get('format')).toBe('json'); expect(url.searchParams.get('q')).toBe('harbor 10 warranty');
    expect(out).toHaveLength(5); expect(out[1]).toEqual({ url: 'https://b.test/', title: 'B', content: '' });
  });
  it('fails loudly on an error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 403 })));
    await expect(searxng('https://example.test/searx', 'q', new AbortController().signal)).rejects.toThrow('403');
  });
  it('needs an address, not a key', () => {
    const s = { tripleCheckSearch: 'searxng' } as SettingsRecord;
    expect(searchConfigurationError(s)).toContain('SearXNG');
    expect(searchConfigurationError({ ...s, searxngBaseUrl: 'http://localhost:8888' })).toBeNull();
  });
});
