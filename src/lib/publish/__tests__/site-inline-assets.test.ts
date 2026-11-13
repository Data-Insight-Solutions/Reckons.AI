/** F294.7 — an asset shown inline on a page: same-origin frame only, lazy images, CSP unchanged otherwise. */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../site-build';
import { sanitizePageHtml } from '../output-policy';

const FIXTURE = join(process.cwd(), 'src/lib/publish/__tests__/fixtures/landing-site');
const tmp: string[] = [];
afterEach(() => { while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true }); });

function build(extra?: string): string {
  const site = mkdtempSync(join(tmpdir(), 'inline-site-'));
  const out = mkdtempSync(join(tmpdir(), 'inline-out-')) + '/site';
  tmp.push(site, join(out, '..'));
  cpSync(FIXTURE, site, { recursive: true });
  if (extra) appendFileSync(join(site, 'content/about.md'), '\n\n' + extra + '\n');
  buildSite({ site, out });
  return readFileSync(join(out, 'about/index.html'), 'utf8');
}
const csp = (html: string) => /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];

describe('inline frames and lazy images (F294.7)', () => {
  it('keeps the CSP free of frame-src on a page without a frame', () => {
    expect(csp(build())).not.toContain('frame-src');
  });
  it("adds frame-src 'self' only when the page holds a same-origin frame", () => {
    const html = build('<iframe src="/assets/ring/ring-viewer" title="Ring" class="embed-4x3"></iframe>');
    expect(html).toContain('<iframe src="/assets/ring/ring-viewer"');
    expect(html).toContain('loading="lazy"');
    expect(csp(html)).toMatch(/; frame-src 'self'$/);
    expect(csp(html)).not.toContain('*');
  });
  it('strips an off-origin frame and keeps the CSP without frame-src', () => {
    for (const src of ['https://evil.example/x', '//evil.example/x', 'javascript:alert(1)', 'assets/x']) {
      const html = build(`<iframe src="${src}"></iframe>`);
      expect(html, src).not.toContain('<iframe');
      expect(csp(html), src).not.toContain('frame-src');
    }
  });
  it('drops unlisted frame attributes', () => {
    const out = sanitizePageHtml('<iframe src="/a" onload="x()" sandbox="" srcdoc="<b>" style="x:y" class="evil"></iframe>');
    expect(out).toBe('<iframe src="/a" loading="lazy"></iframe>');
  });
  it('renders content images lazy and async', () => {
    expect(sanitizePageHtml('<img src="/a.png" alt="x">')).toBe('<img src="/a.png" alt="x" loading="lazy" decoding="async" />');
  });
});

describe('guided-scroll control on sections pages (F274.4.3)', () => {
  function site(guided: boolean): string {
    const src = mkdtempSync(join(tmpdir(), 'guide-site-'));
    const out = mkdtempSync(join(tmpdir(), 'guide-out-')) + '/site';
    tmp.push(src, join(out, '..'));
    cpSync(FIXTURE, src, { recursive: true });
    const cfgFile = join(src, 'site.config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    if (guided) cfg.guidedScroll = { dwellSeconds: 8 }; else delete cfg.guidedScroll;
    writeFileSync(cfgFile, JSON.stringify(cfg));
    writeFileSync(join(src, 'content/team.md'), '---\ntitle: Team\nslug: team\ntemplate: sections\nstatus: published\nexcerpt: Team.\n---\n\n## One\n@section: text\n\nFirst.\n\n## Two\n@section: text\n\nSecond.\n');
    buildSite({ site: src, out });
    return out;
  }
  it('is on landing and sections pages, off on doc pages', () => {
    const out = site(true);
    for (const f of ['index.html', 'team/index.html']) expect(readFileSync(join(out, f), 'utf8'), f).toContain('id="guide"');
    for (const f of ['contact/index.html', 'about/index.html']) expect(readFileSync(join(out, f), 'utf8'), f).not.toContain('id="guide"');
    expect(csp(readFileSync(join(out, 'team/index.html'), 'utf8'))).toContain("script-src 'self'");
  });
  it('is absent everywhere when guidedScroll is off', () => {
    const out = site(false);
    for (const f of ['index.html', 'team/index.html']) expect(readFileSync(join(out, f), 'utf8'), f).not.toContain('id="guide"');
  });
});
