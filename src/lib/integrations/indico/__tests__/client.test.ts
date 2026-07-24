/**
 * Indico client — the auth path, error surfacing, and category coverage that
 * `kb:int-indico`'s `kpred:remaining` names as the gate on production -> functional.
 *
 * These are OFFLINE tests against a mocked fetch. They pin the CONTRACT (how the
 * token travels, what a bad server/token surfaces as); they do NOT prove the live
 * server accepts our token. That is `npm run indico:verify`, which needs a real
 * server URL and is deliberately a separate, network-touching harness.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IndicoClient, createIndicoClient } from '../client';

const SERVER = 'https://indico.example.org';
const TOKEN = 'ak-test-token';

function jsonOnce(body: unknown, status = 200) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createIndicoClient', () => {
  it('returns null without a server URL — an unconfigured integration must not half-work', () => {
    expect(createIndicoClient(undefined)).toBeNull();
    expect(createIndicoClient('')).toBeNull();
    expect(createIndicoClient('   ')).toBeNull();
  });

  it('builds a client from a server URL alone (public Indico needs no token)', () => {
    expect(createIndicoClient(SERVER)).toBeInstanceOf(IndicoClient);
  });

  it('treats a blank token as absent rather than sending an empty credential', async () => {
    const fetchMock = jsonOnce({ results: [] });
    vi.stubGlobal('fetch', fetchMock);

    await createIndicoClient(SERVER, '   ')!.fetchEvents();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.has('ak')).toBe(false);
  });

  it('strips a trailing slash so the URL never doubles up', async () => {
    const fetchMock = jsonOnce({ results: [] });
    vi.stubGlobal('fetch', fetchMock);

    await createIndicoClient(`${SERVER}/`)!.fetchEvents();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain(`${SERVER}/export/categ/0.json`);
    expect(url).not.toContain('//export');
  });
});

describe('the API-token auth path', () => {
  it('sends the token as the `ak` query param Indico expects', async () => {
    const fetchMock = jsonOnce({ results: [] });
    vi.stubGlobal('fetch', fetchMock);

    await new IndicoClient({ serverUrl: SERVER, apiToken: TOKEN }).fetchEvents();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('ak')).toBe(TOKEN);
  });

  it('carries the token on every endpoint, not just the category listing', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new IndicoClient({ serverUrl: SERVER, apiToken: TOKEN });
    await client.fetchEvents('42');
    await client.searchEvents('workshop');
    await client.getEvent('7');

    for (const call of fetchMock.mock.calls) {
      const [url] = call as unknown as [string];
      expect(new URL(url).searchParams.get('ak')).toBe(TOKEN);
    }
  });

  it('omits `ak` entirely when no token is configured', async () => {
    const fetchMock = jsonOnce({ results: [] });
    vi.stubGlobal('fetch', fetchMock);

    await new IndicoClient({ serverUrl: SERVER }).fetchEvents();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.has('ak')).toBe(false);
  });
});

describe('error surfacing on a bad server or token', () => {
  it('surfaces the status AND the body — a 401 must not read like an empty result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Invalid API key', { status: 401 }))
    );

    await expect(new IndicoClient({ serverUrl: SERVER, apiToken: 'wrong' }).fetchEvents()).rejects.toThrow(
      /Indico 401: Invalid API key/
    );
  });

  it('surfaces a 404 from a wrong server URL rather than returning nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 }))
    );

    await expect(new IndicoClient({ serverUrl: SERVER }).fetchEvents()).rejects.toThrow(/Indico 404/);
  });

  it('propagates a network failure instead of swallowing it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    await expect(new IndicoClient({ serverUrl: SERVER }).fetchEvents()).rejects.toThrow(/Failed to fetch/);
  });
});

describe('event mapping and category coverage', () => {
  const RAW = {
    id: 101,
    title: 'Detector Workshop',
    startDate: { date: '2026-08-03', time: '09:00:00', tz: 'Europe/Zurich' },
    endDate: { date: '2026-08-05', time: '17:00:00', tz: 'Europe/Zurich' },
    category: 'Workshops',
    type: 'meeting',
    url: `${SERVER}/event/101/`,
    location: 'Building 40'
  };

  it('maps a raw export payload onto IndicoEvent, coercing the numeric id to a string', async () => {
    vi.stubGlobal('fetch', jsonOnce({ results: [RAW], count: 1, complete: true }));

    const res = await new IndicoClient({ serverUrl: SERVER }).fetchEvents();

    expect(res.count).toBe(1);
    expect(res.results[0]).toMatchObject({
      id: '101',
      title: 'Detector Workshop',
      category: 'Workshops',
      location: 'Building 40'
    });
  });

  it('defaults a missing startDate rather than emitting undefined into the graph', async () => {
    vi.stubGlobal('fetch', jsonOnce({ results: [{ id: 5, title: 'Untimed' }] }));

    const [ev] = (await new IndicoClient({ serverUrl: SERVER }).fetchEvents()).results;
    expect(ev.startDate).toEqual({ date: '', time: '00:00:00', tz: 'UTC' });
    expect(ev.hasAnyProtection).toBe(false);
  });

  it('honours the limit by slicing results', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: i, title: `E${i}` }));
    vi.stubGlobal('fetch', jsonOnce({ results: many, count: 10 }));

    const res = await new IndicoClient({ serverUrl: SERVER }).fetchEvents(undefined, { limit: 3 });
    expect(res.results).toHaveLength(3);
    expect(res.count).toBe(10);
  });

  it('derives the distinct category names from the root listing, sorted', async () => {
    vi.stubGlobal(
      'fetch',
      jsonOnce({
        results: [
          { id: 1, title: 'a', category: 'Workshops' },
          { id: 2, title: 'b', category: 'Seminars' },
          { id: 3, title: 'c', category: 'Workshops' },
          { id: 4, title: 'd' }
        ]
      })
    );

    expect(await new IndicoClient({ serverUrl: SERVER }).getCategories()).toEqual(['Seminars', 'Workshops']);
  });

  it('returns no categories rather than throwing when the server rejects the listing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 403 }))
    );

    expect(await new IndicoClient({ serverUrl: SERVER }).getCategories()).toEqual([]);
  });

  it('scopes a category fetch to that category path', async () => {
    const fetchMock = jsonOnce({ results: [] });
    vi.stubGlobal('fetch', fetchMock);

    await new IndicoClient({ serverUrl: SERVER }).fetchEvents('42');

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain('/export/categ/42.json');
  });

  it('forceSync asks only for events from today onward', async () => {
    const fetchMock = jsonOnce({ results: [] });
    vi.stubGlobal('fetch', fetchMock);

    await new IndicoClient({ serverUrl: SERVER }).forceSync();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(new URL(url).searchParams.get('from')).toBe(new Date().toISOString().split('T')[0]);
  });
});

describe('VITE_INDICO_* reaches the client', () => {
  /**
   * The regression this exists to prevent. `VITE_INDICO_API_TOKEN` was added to .env and read
   * NOWHERE: db.ts seeds ~15 other credentials from import.meta.env but skipped the Indico pair,
   * so the token sat in .env doing nothing and the integration still looked unconfigured.
   */
  /**
   * Asserted against the SOURCE rather than by re-importing db.ts under a stubbed env. The
   * re-import approach needs vi.resetModules(), which leaked across the 100-file suite: four
   * unrelated store suites failed in a full run while passing in isolation. The defect being
   * guarded is precisely "these names appear nowhere in db.ts", so reading db.ts for them tests
   * exactly that, deterministically and without touching the module registry.
   */
  it('seeds indicoServerUrl / indicoApiToken / indicoCategoryId in DEFAULT_SETTINGS', async () => {
    const { readFileSync } = await import('node:fs');
    const db = readFileSync('src/lib/storage/db.ts', 'utf8');

    expect(db).toContain('indicoServerUrl: import.meta.env.VITE_INDICO_SERVER_URL');
    expect(db).toContain('indicoApiToken: import.meta.env.VITE_INDICO_API_TOKEN');
    expect(db).toContain('indicoCategoryId: import.meta.env.VITE_INDICO_CATEGORY_ID');
  });

  it('falls back to undefined so an unconfigured install stays unconfigured', async () => {
    const { readFileSync } = await import('node:fs');
    const db = readFileSync('src/lib/storage/db.ts', 'utf8');

    // `|| undefined` (not `??`) so an empty-string env var reads as absent, matching every other
    // credential in the block — a blank VITE_ var must not configure the integration.
    for (const key of ['VITE_INDICO_SERVER_URL', 'VITE_INDICO_API_TOKEN', 'VITE_INDICO_CATEGORY_ID']) {
      expect(db).toMatch(new RegExp(`import\\.meta\\.env\\.${key} \\|\\| undefined`));
    }
  });

  it('never rides along in a shareable export — indicoApiToken is redacted by name', async () => {
    const { redactSecrets } = await import('../../../safety/redact');
    const out = redactSecrets({ indicoServerUrl: SERVER, indicoApiToken: TOKEN }) as Record<string, unknown>;

    expect(out.indicoServerUrl).toBe(SERVER);
    expect('indicoApiToken' in out).toBe(false);
  });
});
