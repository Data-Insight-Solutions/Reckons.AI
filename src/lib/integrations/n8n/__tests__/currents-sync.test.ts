import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Source, Statement } from '../../../rdf/types';
import type { CurrentDef } from '../../../rdf/currents';

// ── Mocks ────────────────────────────────────────────────────────────────────

let mockSources: Source[] = [];
let mockSettings: Record<string, unknown> = { n8nBaseUrl: 'https://n8n.test.example' };
const addSourceMock = vi.fn(async (src: Source) => {
  mockSources = [src, ...mockSources];
});
const addStatementsMock = vi.fn(
  async (_sts: Statement[], _sourceId?: string, _opts?: { origin?: 'manual' | 'current' }) => {}
);

vi.mock('../../../stores/kb.svelte', () => ({
  addSource: (src: Source) => addSourceMock(src),
  addStatements: (sts: Statement[], sourceId?: string, opts?: { origin?: 'manual' | 'current' }) =>
    addStatementsMock(sts, sourceId, opts),
  sources: () => mockSources
}));

vi.mock('../../../stores/settings.svelte', () => ({
  settings: () => mockSettings
}));

const { registerCurrent, fetchCurrentItems, fetchCurrentDirect, processArrivals } = await import('../currents-sync');

// ── Helpers ──────────────────────────────────────────────────────────────────

function mkDef(overrides: Partial<CurrentDef> = {}): CurrentDef {
  return {
    slug: 'hn',
    sourceUrl: 'https://hnrss.org/frontpage',
    kind: 'rss',
    label: 'Hacker News',
    cadenceMinutes: 60,
    enabled: true,
    ...overrides
  };
}

beforeEach(() => {
  mockSources = [];
  mockSettings = { n8nBaseUrl: 'https://n8n.test.example' };
  addSourceMock.mockClear();
  addStatementsMock.mockClear();
  vi.unstubAllGlobals();
});

// ── registerCurrent ──────────────────────────────────────────────────────────

describe('registerCurrent', () => {
  it('POSTs the current definition to the register webhook', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await registerCurrent(mkDef(), 'kb-stable-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://n8n.test.example/webhook/reckons-currents-register');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({
      graphStableId: 'kb-stable-1',
      slug: 'hn',
      sourceUrl: 'https://hnrss.org/frontpage',
      kind: 'rss',
      cadenceMinutes: 60,
      enabled: true,
      label: 'Hacker News'
    });
  });

  it('throws when the webhook responds with a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('nope', { status: 500 })));
    await expect(registerCurrent(mkDef(), 'kb-1')).rejects.toThrow(/HTTP 500/);
  });

  it('throws a clear error when n8nBaseUrl is not configured', async () => {
    mockSettings = {};
    await expect(registerCurrent(mkDef(), 'kb-1')).rejects.toThrow(/n8n base URL not configured/);
  });

  it('strips a trailing slash from n8nBaseUrl before building the URL', async () => {
    mockSettings = { n8nBaseUrl: 'https://n8n.test.example/' };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await registerCurrent(mkDef(), 'kb-1');
    expect(fetchMock.mock.calls[0][0]).toBe('https://n8n.test.example/webhook/reckons-currents-register');
  });
});

// ── fetchCurrentItems ────────────────────────────────────────────────────────

describe('fetchCurrentItems', () => {
  it('builds a GET request with graphStableId (and since when provided)', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await fetchCurrentItems('kb-stable-1');
    let calledUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(calledUrl.pathname).toBe('/webhook/reckons-currents-items');
    expect(calledUrl.searchParams.get('graphStableId')).toBe('kb-stable-1');
    expect(calledUrl.searchParams.has('since')).toBe(false);

    await fetchCurrentItems('kb-stable-1', '2026-07-01T00:00:00.000Z');
    calledUrl = new URL(fetchMock.mock.calls[1][0] as string);
    expect(calledUrl.searchParams.get('since')).toBe('2026-07-01T00:00:00.000Z');
  });

  it('returns the parsed array of items', async () => {
    const items = [{ title: 'A', url: 'https://example.com/a', currentSlug: 'hn', graphStableId: 'kb-1', fetchedAt: 'x' }];
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(items), { status: 200 })));
    await expect(fetchCurrentItems('kb-1')).resolves.toEqual(items);
  });

  it('returns [] when the response is not an array', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"oops":true}', { status: 200 })));
    await expect(fetchCurrentItems('kb-1')).resolves.toEqual([]);
  });

  it('throws when the webhook responds with a non-ok status', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('nope', { status: 404 })));
    await expect(fetchCurrentItems('kb-1')).rejects.toThrow(/HTTP 404/);
  });
});

// ── fetchCurrentDirect ───────────────────────────────────────────────────────

const RSS_FIXTURE = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example Feed</title>
  <item>
    <title>First Post</title>
    <link>https://example.com/first</link>
    <pubDate>Fri, 03 Jul 2026 12:00:00 GMT</pubDate>
    <description>First summary</description>
  </item>
  <item>
    <title>Second Post</title>
    <link>https://example.com/second</link>
    <pubDate>Fri, 03 Jul 2026 13:00:00 GMT</pubDate>
    <description>Second summary</description>
  </item>
</channel></rss>`;

const ATOM_FIXTURE = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Atom Feed</title>
  <entry>
    <title>Atom Post</title>
    <link rel="alternate" href="https://example.com/atom-post"/>
    <updated>2026-07-03T12:00:00Z</updated>
    <summary>Atom summary</summary>
  </entry>
</feed>`;

describe('fetchCurrentDirect', () => {
  it('parses RSS 2.0 items into CurrentItem[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(RSS_FIXTURE, { status: 200 })));
    const items = await fetchCurrentDirect(mkDef(), 'kb-1');
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'First Post',
      url: 'https://example.com/first',
      summary: 'First summary',
      currentSlug: 'hn',
      graphStableId: 'kb-1',
      sourceLabel: 'Hacker News'
    });
  });

  it('parses Atom entries into CurrentItem[]', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(ATOM_FIXTURE, { status: 200 })));
    const items = await fetchCurrentDirect(mkDef({ slug: 'atom-feed', label: 'Atom Feed' }), 'kb-1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Atom Post',
      url: 'https://example.com/atom-post',
      summary: 'Atom summary',
      publishedAt: '2026-07-03T12:00:00Z'
    });
  });

  it('throws a clear CORS-flavoured error when the browser fetch itself fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
        throw new TypeError('Failed to fetch');
      })
    );
    await expect(fetchCurrentDirect(mkDef())).rejects.toThrow(/CORS/);
  });

  it('throws on a non-ok HTTP response', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('nope', { status: 503 })));
    await expect(fetchCurrentDirect(mkDef())).rejects.toThrow(/HTTP 503/);
  });

  it('throws when the response cannot be parsed as XML', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('<<<not xml', { status: 200 })));
    await expect(fetchCurrentDirect(mkDef())).rejects.toThrow(/RSS\/Atom/);
  });
});

// ── processArrivals ──────────────────────────────────────────────────────────

describe('processArrivals', () => {
  it('creates one Source for the current and builds arrival statements per item', async () => {
    const items = [
      { title: 'Post A', url: 'https://example.com/a', currentSlug: 'hn', graphStableId: 'kb-1', fetchedAt: 'x', summary: 'Summary A' },
      { title: 'Post B', url: 'https://example.com/b', currentSlug: 'hn', graphStableId: 'kb-1', fetchedAt: 'x' }
    ];

    const result = await processArrivals(items, mkDef(), 'kb-1');

    expect(addSourceMock).toHaveBeenCalledTimes(1);
    const createdSource = addSourceMock.mock.calls[0][0] as Source;
    expect(createdSource.uri).toBe('current://kb-1/hn');
    expect(createdSource.kind).toBe('url');

    expect(addStatementsMock).toHaveBeenCalledTimes(2);
    for (const call of addStatementsMock.mock.calls) {
      expect(call[1]).toBe(createdSource.id); // sourceId
      expect(call[2]).toEqual({ origin: 'current' });
    }

    expect(result.processed).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.statementCount).toBeGreaterThan(0);
  });

  it('reuses an existing Source for the same current instead of creating a new one', async () => {
    mockSources = [
      { id: 'existing-src', title: 'Hacker News', uri: 'current://kb-1/hn', ingestedAt: 1, kind: 'url' }
    ];
    await processArrivals(
      [{ title: 'Post A', url: 'https://example.com/a', currentSlug: 'hn', graphStableId: 'kb-1', fetchedAt: 'x' }],
      mkDef(),
      'kb-1'
    );
    expect(addSourceMock).not.toHaveBeenCalled();
    expect(addStatementsMock.mock.calls[0][1]).toBe('existing-src');
  });

  it('skips items missing a title or url', async () => {
    const items = [
      { title: '', url: 'https://example.com/a', currentSlug: 'hn', graphStableId: 'kb-1', fetchedAt: 'x' },
      { title: 'No URL', url: '', currentSlug: 'hn', graphStableId: 'kb-1', fetchedAt: 'x' },
      { title: 'Good', url: 'https://example.com/good', currentSlug: 'hn', graphStableId: 'kb-1', fetchedAt: 'x' }
    ];
    const result = await processArrivals(items, mkDef(), 'kb-1');
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(2);
    expect(addStatementsMock).toHaveBeenCalledTimes(1);
  });

  it('returns zeros and makes no calls for an empty item list', async () => {
    const result = await processArrivals([], mkDef(), 'kb-1');
    expect(result).toEqual({ processed: 0, skipped: 0, statementCount: 0 });
    expect(addSourceMock).not.toHaveBeenCalled();
    expect(addStatementsMock).not.toHaveBeenCalled();
  });
});
