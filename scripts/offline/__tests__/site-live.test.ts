/** F294.6 site-live: pure rules with fixtures; fetch, dns and git are injected, so no network is touched. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractRefs, judgeResponse, parseSitemap, parseStamp, compareStamp, diffDns, checkSite, dnsCheck, stateDir,
  type Fetcher, type DnsResolver, type Git,
} from '../site-live';

const PAGE = 'https://example.test/about/';
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }); });

describe('extractRefs', () => {
  it('collects same-origin links and assets, counts external ones, drops fragments and mailto', () => {
    const html = `<a href="/x/">x</a><a href='../y.pdf#p2'>y</a><img src="a.webp"><script src="/s.js"></script>
      <link rel="stylesheet" href="/c.css"><source src="/v.mp4"><a href="https://other.test/">o</a><a href="mailto:a@b.c">m</a><a href="#top">t</a>`;
    const r = extractRefs(html, PAGE);
    expect(r.internal).toEqual(['https://example.test/about/a.webp', 'https://example.test/c.css', 'https://example.test/s.js',
      'https://example.test/v.mp4', 'https://example.test/x/', 'https://example.test/y.pdf']);
    expect(r.externalCount).toBe(1);
  });
});

describe('judgeResponse', () => {
  it('passes a matching type and a page', () => {
    expect(judgeResponse('https://e.test/a.webp', 200, 'image/webp')).toBeNull();
    expect(judgeResponse('https://e.test/a/', 200, 'text/html; charset=utf-8')).toBeNull();
    expect(judgeResponse('https://e.test/m.glb', 200, 'application/octet-stream')).toBeNull();
  });
  it('flags a fallback HTML page served for a missing file even though it is 200', () => {
    expect(judgeResponse('https://e.test/a.webp', 200, 'text/html')).toMatch(/fallback page.*missing/);
  });
  it('flags a wrong type, a missing type and a non-200', () => {
    expect(judgeResponse('https://e.test/a.png', 200, 'image/jpeg')).toMatch(/served as image\/jpeg/);
    expect(judgeResponse('https://e.test/a/', 200, 'application/json')).toMatch(/content-type/);
    expect(judgeResponse('https://e.test/a.js', 404, 'text/html')).toBe('answered 404');
  });
});

describe('parseSitemap', () => {
  it('keeps same-origin entries only', () => {
    const xml = '<urlset><url><loc>https://example.test/</loc></url><url><loc> https://example.test/b/ </loc></url><url><loc>https://x.test/c/</loc></url></urlset>';
    expect(parseSitemap(xml, 'https://example.test')).toEqual(['https://example.test/', 'https://example.test/b/']);
  });
});

describe('stamp comparison', () => {
  const stamp = (c: string | null) => parseStamp(JSON.stringify({ generator: 'Reckons.AI', version: '1', siteCommit: c, builtAt: 'x' }));
  it('current, behind, unknown distance, no stamp, no commit', () => {
    expect(compareStamp(stamp('a'), 'a', () => 0).kind).toBe('current');
    expect(compareStamp(stamp('a'), 'b', () => 3)).toMatchObject({ kind: 'behind', behind: 3 });
    expect(compareStamp(stamp('a'), 'b', () => null).kind).toBe('ahead-or-diverged');
    expect(compareStamp(null, 'b', () => 0).kind).toBe('no-stamp');
    expect(compareStamp(stamp(null), 'b', () => 0).kind).toBe('no-commit');
  });
  it('refuses a foreign or unparseable stamp', () => {
    expect(parseStamp('<html>')).toBeNull();
    expect(parseStamp('{"generator":"x"}')).toBeNull();
    expect(parseStamp(null)).toBeNull();
  });
});

describe('diffDns', () => {
  it('reports only the record types that changed, as counts', () => {
    const a = { 'e.test': { MX: ['0 m'], TXT: ['v=spf1', 'x'] } };
    const b = { 'e.test': { MX: ['0 m'], TXT: ['v=spf1'] } };
    expect(diffDns(a, a)).toEqual([]);
    expect(diffDns(a, b)).toEqual([{ host: 'e.test', type: 'TXT', before: 2, after: 1 }]);
  });
});

function site(map: Record<string, { status?: number; ct?: string; body?: string }>): Fetcher {
  return async (url, method) => {
    const u = new URL(url);
    const hit = map[u.pathname];
    if (!hit) return { status: 404, contentType: 'text/html', text: method === 'GET' ? '' : null };
    return { status: hit.status ?? 200, contentType: hit.ct ?? null, text: method === 'GET' ? (hit.body ?? '') : null };
  };
}

describe('checkSite (injected fetch and git)', () => {
  const fx = site({
    '/': { ct: 'text/html', body: '<a href="/about/">a</a><img src="/ok.webp"><img src="/gone.webp"><a href="https://o.test/">o</a>' },
    '/about/': { ct: 'text/html', body: '<a href="/">h</a>' },
    '/ok.webp': { ct: 'image/webp' },
    '/gone.webp': { ct: 'text/html' },
  });
  it('finds the fallback page, counts external, and reports no stamp as unknown', async () => {
    const git: Git = () => '';
    const r = await checkSite({ url: 'https://example.test', maxPages: 10, fetcher: fx, git });
    expect(r.pages).toBe(2);
    expect(r.assets).toBe(2);
    expect(r.externalLinks).toBe(1);
    expect(r.findings).toEqual(['asset /gone.webp: served a fallback page (text/html) for a .webp file, the file is missing']);
    expect(r.unknowns.join()).toMatch(/predates the build stamp/);
  });
  it('reports behind main from the stamp', async () => {
    const withStamp = site({ '/': { ct: 'text/html', body: '' }, '/reckons-build.json': { ct: 'application/json', body: JSON.stringify({ generator: 'Reckons.AI', siteCommit: 'aaaaaaaaaa', version: '1', builtAt: 'x' }) } });
    const git: Git = (a) => (a[0] === 'rev-list' ? '4' : a[0] === 'rev-parse' ? 'bbbbbbbbbb' : '');
    const r = await checkSite({ url: 'https://example.test', maxPages: 10, fetcher: withStamp, git });
    expect(r.findings).toEqual(['freshness: live is 4 commit(s) behind origin/main (live aaaaaaaa)']);
  });
  it('says the fetch failed when it did', async () => {
    const withStamp = site({ '/': { ct: 'text/html', body: '' }, '/reckons-build.json': { ct: 'application/json', body: JSON.stringify({ generator: 'Reckons.AI', siteCommit: 'a', version: '1', builtAt: 'x' }) } });
    const git: Git = (a) => (a[0] === 'fetch' ? null : a[0] === 'rev-parse' ? 'a' : '0');
    const r = await checkSite({ url: 'https://example.test', maxPages: 10, fetcher: withStamp, git });
    expect(r.findings).toEqual([]);
    expect(r.unknowns.join()).toMatch(/git fetch failed/);
  });
  it('caps pages at max-pages and says so', async () => {
    const r = await checkSite({ url: 'https://example.test', maxPages: 1, fetcher: fx, git: () => '' });
    expect(r.pages).toBe(1);
    expect(r.unknowns.join()).toMatch(/beyond --max-pages=1/);
  });
});

describe('dnsCheck baseline', () => {
  const dns = (txt: string[]): DnsResolver => ({ mx: async () => ['0 mail.e.test'], txt: async () => txt, cname: async () => ['x.e.test'] });
  it('records on first run (private modes), then reports a changed type by count only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'site-live-')); dirs.push(root);
    const dir = stateDir('e.test', { XDG_STATE_HOME: root });
    const first = await dnsCheck(dns(['v=spf1']), ['e.test'], dir);
    expect(first.findings).toEqual([]);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'dns-baseline.json')).mode & 0o777).toBe(0o600);
    const same = await dnsCheck(dns(['v=spf1']), ['e.test'], dir);
    expect(same.findings).toEqual([]);
    const changed = await dnsCheck(dns(['v=spf1', 'extra-secret-token']), ['e.test'], dir);
    expect(changed.findings).toHaveLength(1);
    expect(changed.findings[0]).toContain('TXT changed');
    expect(changed.findings[0]).not.toContain('extra-secret-token');
    expect(readFileSync(join(dir, 'dns-last.json'), 'utf8')).toContain('extra-secret-token');
    await dnsCheck(dns(['v=spf1', 'extra-secret-token']), ['e.test'], dir, true);
    expect((await dnsCheck(dns(['v=spf1', 'extra-secret-token']), ['e.test'], dir)).findings).toEqual([]);
  });
  it('writes no baseline when nothing resolves', async () => {
    const root = mkdtempSync(join(tmpdir(), 'site-live-')); dirs.push(root);
    const none: DnsResolver = { mx: async () => [], txt: async () => [], cname: async () => [] };
    const r = await dnsCheck(none, ['e.test'], join(root, 'd'));
    expect(r.unknowns).toHaveLength(1);
    expect(existsSync(join(root, 'd'))).toBe(false);
  });
});
