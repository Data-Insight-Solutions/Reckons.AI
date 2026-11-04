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
  it('refuses to follow a redirect (the query may go only to the allowlisted host)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await searxng('http://localhost:8888', 'harbor 10 warranty', new AbortController().signal);
    const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(init.redirect).toBe('error');
  });
  it('fails loudly on an error response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>', { status: 403 })));
    await expect(searxng('https://example.test/searx', 'q', new AbortController().signal)).rejects.toThrow('403');
  });
  it('defaults to this machine, needs no key, and refuses another host', () => {
    const s = { tripleCheckSearch: 'searxng', tripleCheckWebEnabled: true } as SettingsRecord;
    expect(searchConfigurationError(s)).toBeNull();
    expect(searchConfigurationError({ ...s, searxngBaseUrl: 'http://localhost:8888' })).toBeNull();
    expect(searchConfigurationError({ ...s, searxngBaseUrl: 'https://search.example.com' })).toContain('this machine');
  });
});

describe('web checking is opt-in (Matt, 2026-11-04)', () => {
  it('unset means off: nothing is searched until the person turns it on', async () => {
    const { WEB_CHECK_OFF } = await import('$lib/rdf/triple-check');
    expect(searchConfigurationError({ tripleCheckSearch: 'searxng' } as SettingsRecord)).toBe(WEB_CHECK_OFF);
    expect(searchConfigurationError({ tripleCheckSearch: 'searxng', tripleCheckWebEnabled: false } as SettingsRecord)).toBe(WEB_CHECK_OFF);
    expect(searchConfigurationError({ tripleCheckSearch: 'searxng', tripleCheckWebEnabled: true } as SettingsRecord)).toBeNull();
  });
});
