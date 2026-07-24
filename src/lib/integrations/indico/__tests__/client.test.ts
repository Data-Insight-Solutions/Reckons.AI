/**
 * Indico auth routing.
 *
 * This exists because the integration was silently broken against a modern Indico: a personal
 * token (`indp_…`) was being sent as the legacy `?ak=` query param, which Indico 3.x rejects with
 * 400 "Malformed API key". Personal tokens MUST travel in the Authorization header; only the old
 * fixed API keys use `ak=`. Verified against a live server. These tests pin which token shape goes
 * where, so a regression can't quietly break connection again.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { IndicoClient } from '../client';

/** Capture the URL + headers of the request the client makes, returning an empty result set. */
function stubFetch() {
  const fn = vi.fn(async () => new Response(JSON.stringify({ results: [], count: 0 }), { status: 200 }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.restoreAllMocks());

describe('Indico auth routing', () => {
  it('sends a personal token (indp_) as a Bearer header, NOT as ?ak=', async () => {
    const fetchMock = stubFetch();
    await new IndicoClient({ serverUrl: 'https://indico.example.com', apiToken: 'indp_secrettoken' }).fetchEvents();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer indp_secrettoken');
    expect(url).not.toContain('ak=');
    expect(url).not.toContain('indp_'); // the token never leaks into the URL/query
  });

  it('sends a legacy fixed key as ?ak=, not a Bearer header', async () => {
    const fetchMock = stubFetch();
    await new IndicoClient({ serverUrl: 'https://indico.example.com', apiToken: 'abc123legacykey' }).fetchEvents();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('ak=abc123legacykey');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('sends no auth at all when there is no token (public server)', async () => {
    const fetchMock = stubFetch();
    await new IndicoClient({ serverUrl: 'https://indico.example.com' }).fetchEvents();

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain('ak=');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('trims a trailing slash on the server URL so the export path is well-formed', async () => {
    const fetchMock = stubFetch();
    await new IndicoClient({ serverUrl: 'https://indico.example.com/', apiToken: 'indp_x' }).fetchEvents();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('https://indico.example.com/export/categ/0.json');
    expect(url).not.toContain('.com//export');
  });
});
