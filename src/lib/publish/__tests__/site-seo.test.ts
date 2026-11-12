/**
 * F274.4.6 done-test — robots.txt, sitemap.xml, canonical, og:url, absolute og:image, and the
 * knowledge.ttl alternate link only when the build writes that file. Synthetic fixtures only.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../site-build';
import { parseSiteConfig } from '../site-config';

const FIXTURE = join(process.cwd(), 'src/lib/publish/__tests__/fixtures/landing-site');
const PLAIN = join(process.cwd(), 'src/lib/publish/__tests__/fixtures/fixture-site');
const tmp: string[] = [];
afterEach(() => { while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true }); });

function build(src: string, config?: Record<string, unknown>, drafts = false) {
  const site = mkdtempSync(join(tmpdir(), 'seo-site-'));
  const outDir = mkdtempSync(join(tmpdir(), 'seo-out-'));
  tmp.push(site, outDir);
  cpSync(src, site, { recursive: true });
  if (config) {
    const file = join(site, 'site.config.json');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    writeFileSync(file, JSON.stringify({ ...cfg, ...config }));
  }
  const out = join(outDir, 'site');
  const result = buildSite({ site, out, includeDrafts: drafts });
  return { out, result, read: (p: string) => readFileSync(join(out, p), 'utf8') };
}

describe('site address given', () => {
  const b = () => build(FIXTURE, { url: 'https://example.test/', ogImage: 'assets/og.png' });

  it('writes robots.txt with a Sitemap line and a sitemap of published pages only', () => {
    const { read } = b();
    expect(read('robots.txt')).toContain('Allow: /');
    expect(read('robots.txt')).toContain('Sitemap: https://example.test/sitemap.xml');
    const sm = read('sitemap.xml');
    expect(sm).toContain('<loc>https://example.test/</loc>');
    expect(sm).toContain('<loc>https://example.test/about/</loc>');
    expect(sm).not.toContain('draft');
  });

  it('gives each page a canonical, an og:url and an absolute og:image', () => {
    const { read } = b();
    const about = read('about/index.html');
    expect(about).toContain('<link rel="canonical" href="https://example.test/about/">');
    expect(about).toContain('<meta property="og:url" content="https://example.test/about/">');
    expect(read('index.html')).toContain('<link rel="canonical" href="https://example.test/">');
    expect(about).toContain('<meta property="og:image" content="https://example.test/assets/og.png">');
  });

  it('rejects an address that is not an https origin', () => {
    expect(() => parseSiteConfig({ title: 'X', url: 'http://example.test' })).toThrow(/https/);
    expect(() => parseSiteConfig({ title: 'X', url: 'https://example.test/sub/' })).toThrow(/origin only/);
    expect(() => parseSiteConfig({ title: 'X', url: 'nonsense' })).toThrow(/not a URL/);
  });
});

describe('site address absent', () => {
  it('writes robots.txt with no Sitemap line, no sitemap, no canonical, a relative og:image, and says so', () => {
    const { out, read, result } = build(FIXTURE, { ogImage: 'assets/og.png' });
    expect(read('robots.txt')).toBe('User-agent: *\nAllow: /\n');
    expect(existsSync(join(out, 'sitemap.xml'))).toBe(false);
    const html = read('index.html');
    expect(html).not.toContain('rel="canonical"');
    expect(html).not.toContain('og:url');
    expect(html).toContain('<meta property="og:image" content="/assets/og.png">');
    expect(result.seoNote).toMatch(/no "url"/);
  });
});

describe('drafts and noindex', () => {
  it('a draft preview and a noindex site disallow everything and have no sitemap', () => {
    const d = build(FIXTURE, { url: 'https://example.test' }, true);
    expect(d.read('robots.txt')).toContain('Disallow: /');
    expect(existsSync(join(d.out, 'sitemap.xml'))).toBe(false);
    const n = build(FIXTURE, { url: 'https://example.test', noindex: true });
    expect(n.read('robots.txt')).toContain('Disallow: /');
    expect(existsSync(join(n.out, 'sitemap.xml'))).toBe(false);
  });
});

describe('knowledge.ttl alternate link', () => {
  it('no build page links knowledge.ttl, because site:build does not write it', () => {
    for (const src of [FIXTURE, PLAIN]) {
      const { out, read, result } = build(src);
      expect(existsSync(join(out, 'knowledge.ttl'))).toBe(false);
      for (const f of result.files.filter((p) => p.endsWith('.html'))) expect(read(f)).not.toContain('knowledge.ttl');
    }
  });
});
