import { describe, it, expect } from 'vitest';
import { looksLikeTurtleUrl, extractAlternateTtlHref, fetchTurtleFromUrl } from '../turtle-url';

const TTL = '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n<urn:kbase:concept/a> rdfs:label "A" .';

function mockFetch(map: Record<string, { body: string; type?: string; ok?: boolean }>): typeof fetch {
  return (async (url: string) => {
    const hit = map[String(url)];
    if (!hit) return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' } as unknown as Response;
    return {
      ok: hit.ok ?? true,
      status: 200,
      headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? hit.type ?? null : null) },
      text: async () => hit.body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('looksLikeTurtleUrl', () => {
  it('matches .ttl / .turtle paths, ignores query/hash', () => {
    expect(looksLikeTurtleUrl('https://x.com/graph.ttl')).toBe(true);
    expect(looksLikeTurtleUrl('https://x.com/a/b.turtle?v=2')).toBe(true);
    expect(looksLikeTurtleUrl('https://x.com/page.html')).toBe(false);
    expect(looksLikeTurtleUrl('https://x.com/')).toBe(false);
  });
});

describe('extractAlternateTtlHref', () => {
  it('finds a rel=alternate type=text/turtle link and resolves it', () => {
    const html = '<head><link rel="alternate" type="text/turtle" href="/graph.ttl"><title>x</title></head>';
    expect(extractAlternateTtlHref(html, 'https://x.com/page')).toBe('https://x.com/graph.ttl');
  });
  it('ignores non-turtle alternates and other rels', () => {
    const html = '<link rel="alternate" type="application/rss+xml" href="/feed"><link rel="stylesheet" href="/s.css">';
    expect(extractAlternateTtlHref(html, 'https://x.com/')).toBeNull();
  });
});

describe('fetchTurtleFromUrl', () => {
  it('returns the body for a .ttl URL', async () => {
    const f = mockFetch({ 'https://x.com/g.ttl': { body: TTL } });
    expect(await fetchTurtleFromUrl('https://x.com/g.ttl', f)).toBe(TTL);
  });
  it('returns the body when content-type is text/turtle', async () => {
    const f = mockFetch({ 'https://x.com/g': { body: TTL, type: 'text/turtle; charset=utf-8' } });
    expect(await fetchTurtleFromUrl('https://x.com/g', f)).toBe(TTL);
  });
  it('follows a rel=alternate turtle link from an HTML page', async () => {
    const f = mockFetch({
      'https://x.com/page': { body: '<link rel="alternate" type="text/turtle" href="/g.ttl">', type: 'text/html' },
      'https://x.com/g.ttl': { body: TTL },
    });
    expect(await fetchTurtleFromUrl('https://x.com/page', f)).toBe(TTL);
  });
  it('returns null for a plain HTML page with no turtle link', async () => {
    const f = mockFetch({ 'https://x.com/page': { body: '<!doctype html><html><body>hi</body></html>', type: 'text/html' } });
    expect(await fetchTurtleFromUrl('https://x.com/page', f)).toBeNull();
  });
  it('returns null (not throw) on a CORS/network failure', async () => {
    const f = (async () => { throw new Error('CORS'); }) as unknown as typeof fetch;
    expect(await fetchTurtleFromUrl('https://x.com/g.ttl', f)).toBeNull();
  });
  it('rejects an HTML error page served at a .ttl URL', async () => {
    const f = mockFetch({ 'https://x.com/g.ttl': { body: '<!doctype html><html>404</html>' } });
    expect(await fetchTurtleFromUrl('https://x.com/g.ttl', f)).toBeNull();
  });
});
