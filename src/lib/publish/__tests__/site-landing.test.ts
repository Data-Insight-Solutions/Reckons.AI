/**
 * F274.4.3 — the landing layout. The browser half of the done-test (no script errors and no
 * horizontal scroll at 390 and 1440 px) is scripts/offline/site-layout-check.ts; this file covers
 * everything that can be asserted on the built files: sections, brand values from config, the
 * webhook-or-mailto contact choice, the CSP, and that no brand text lives in the engine.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSite } from '../site-build';
import { parseLanding, landingCss, landingJs, GUIDE_LOGIC } from '../site-landing';
import { parseSiteConfig } from '../site-config';

const FIXTURE = join(process.cwd(), 'src/lib/publish/__tests__/fixtures/landing-site');
const tmp: string[] = [];
afterEach(() => { while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true }); });

/** Copy the fixture, let `edit` change its config, build it, return the output dir. */
function build(edit?: (cfg: Record<string, any>) => void): string {
  const site = mkdtempSync(join(tmpdir(), 'landing-site-'));
  const out = mkdtempSync(join(tmpdir(), 'landing-out-')) + '/site';
  tmp.push(site, join(out, '..'));
  cpSync(FIXTURE, site, { recursive: true });
  if (edit) {
    const file = join(site, 'site.config.json');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    edit(cfg);
    writeFileSync(file, JSON.stringify(cfg));
  }
  buildSite({ site, out });
  return out;
}
const read = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8');

describe('landing layout (F274.4.3)', () => {
  it('renders every section kind of the approved design from page sections', () => {
    const html = read(build(), 'index.html');
    for (const marker of ['class="aurora"', 'class="hero"', 'class="bento"', 'class="path"', 'class="engage cols-3"', 'class="about"', 'class="speaking panel', 'class="contact"', 'id="menu-btn"', 'id="theme-btn"']) {
      expect(html, marker).toContain(marker);
    }
    expect(html).toContain('<span class="grad">busy people</span>');
    expect((html.match(/class="card panel/g) ?? []).length).toBe(4);
    expect(html).toContain('<div class="stat">1,000</div>');
    expect(html).toContain('<span class="tag">alpha</span>');
    expect(html).toContain('class="timeline"');
    expect(html).toContain('class="options"');
    expect(html).not.toContain('Ignored text before the first section');
  });

  it('puts site-wide navigation on every page and marks the current one', () => {
    const out = build();
    for (const rel of ['index.html', 'services/index.html', 'about/index.html', 'contact/index.html']) {
      const html = read(out, rel);
      for (const label of ['Home', 'Services', 'About', 'Blog', 'Contact']) expect(html, rel + ' ' + label).toContain('>' + label + '</a>');
    }
    expect(read(out, 'about/index.html')).toContain('<a href="/about/" aria-current="page">About</a>');
  });

  it('uses the layout with no inline script or style, and one stylesheet plus one script', () => {
    const out = build();
    const html = read(out, 'index.html');
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(html).not.toMatch(/<style[\s>]/);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).toContain('<link rel="stylesheet" href="/landing.css">');
    expect(html).toContain('<script src="/landing.js"></script>');
    expect(readdirSync(out)).toEqual(expect.arrayContaining(['landing.css', 'landing.js']));
  });

  it('sends the contact form to the configured webhook and nowhere else', () => {
    const out = build();
    const html = read(out, 'index.html');
    expect(html).toContain('action="https://hooks.example.test/webhook/studio-contact"');
    expect(html).toContain('data-tag="example-landing"');
    expect(html).toContain('<option>A project</option>');
    expect(html).toContain("connect-src https://hooks.example.test; form-action https://hooks.example.test");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toContain("script-src 'none'");
    // the contact page carries the form too, because every post and page links to /contact
    expect(read(out, 'contact/index.html')).toContain('id="contact-form"');
    expect(read(out, 'about/index.html')).not.toContain('id="contact-form"');
  });

  it('falls back to a mailto link when no webhook is configured, and to nothing without an address', () => {
    const mail = read(build((c) => { delete c.contact.webhook; }), 'index.html');
    expect(mail).not.toContain('<form');
    expect(mail).toContain('href="mailto:hello@example.test"');
    expect(mail).toContain("connect-src 'none'; form-action 'none'");
    const none = read(build((c) => { delete c.contact.webhook; delete c.contact.email; }), 'index.html');
    expect(none).not.toContain('<form');
    expect(none).not.toContain('mailto:');
  });

  it('takes every brand value from the theme: changing the config changes the output', () => {
    const base = read(build(), 'landing.css');
    expect(base).toContain('--accent:#e0662f');
    expect(base).toContain('--display:system-ui, sans-serif');
    const other = read(build((c) => {
      c.theme.dark.accent = '#12aa55';
      c.theme.light = { accent: '#0a7a3c' };
      c.theme.displayFont = 'Georgia, serif';
      c.theme.fontFaces = [{ family: 'Test Sans', src: '/assets/test.woff2', weight: '300 700' }];
    }), 'landing.css');
    expect(other).toContain('--accent:#12aa55');
    expect(other).toContain('--accent:#0a7a3c');
    expect(other).toContain('--display:Georgia, serif');
    expect(other).toContain('@font-face{font-family:Test Sans;src:url(/assets/test.woff2)');
    expect(other).not.toContain('#e0662f');
    // both colour schemes are present and a visitor's choice overrides the system's
    expect(base).toContain('@media (prefers-color-scheme: light)');
    expect(base).toContain(':root[data-theme="light"]');
    const logo = read(build((c) => { c.title = 'Other Name'; }), 'index.html');
    expect(logo).toContain('Other Name');
    expect(logo).not.toContain('>Example Studio<');
  });

  it('builds no draft and is byte-identical on a second build', () => {
    const a = build();
    const b = build();
    expect(readdirSync(a).sort()).not.toContain('unfinished');
    for (const f of ['index.html', 'landing.css', 'landing.js', 'about/index.html']) expect(read(a, f)).toBe(read(b, f));
  });

  it('keeps the engine free of any site brand: the css and script carry only config values', () => {
    const cfg = parseSiteConfig({ title: 'X' });
    const css = landingCss(cfg);
    const js = landingJs();
    expect(css).not.toMatch(/n8n|webhook|hstgr/i);
    expect(js).not.toMatch(/https?:\/\//);
    expect(css).not.toMatch(/Grotesk|Plex/);
  });
});

describe('landing section parsing', () => {
  it('reads options, items and ignores headings inside code fences', () => {
    const s = parseLanding('before\n## One\n@section: cards\n@id: a\n\nintro\n\n### Card\n@tag: t\ntext\n\n```\n## not a section\n```\n\n## Two\n');
    expect(s.map((x) => x.title)).toEqual(['One', 'Two']);
    expect(s[0].opts).toEqual({ section: 'cards', id: 'a' });
    expect(s[0].subs[0].opts).toEqual({ tag: 't' });
    expect(s[0].subs[0].body).toContain('## not a section');
  });
});

describe('site config validation', () => {
  it('fails loudly on a bad colour, a non-https webhook, an unsafe link or a missing title', () => {
    expect(() => parseSiteConfig({ title: 'X', theme: { dark: { accent: 'url(x)' } } })).toThrow(/theme\.dark\.accent/);
    expect(() => parseSiteConfig({ title: 'X', theme: { dark: { nope: '#fff' } } })).toThrow(/not a known colour token/);
    expect(() => parseSiteConfig({ title: 'X', contact: { webhook: 'http://evil.example' } })).toThrow(/https/);
    expect(() => parseSiteConfig({ title: 'X', nav: [{ label: 'a', href: 'javascript:alert(1)' }] })).toThrow(/nav\[0\]\.href/);
    expect(() => parseSiteConfig({ title: 'X', logo: '../secret.png' })).toThrow(/site-relative/);
    expect(() => parseSiteConfig({})).toThrow(/title is required/);
  });

  it('defaults to the five-item navigation and neutral palettes', () => {
    const c = parseSiteConfig({ title: 'X' });
    expect(c.nav.map((n) => n.label)).toEqual(['Home', 'Services', 'About', 'Blog', 'Contact']);
    expect(c.contact.webhook).toBeNull();
  });

  it('merges a build-time override file over the config, and the webhook reaches the form without the file path', () => {
    const site = mkdtempSync(join(tmpdir(), 'landing-site-'));
    const outDir = mkdtempSync(join(tmpdir(), 'landing-out-'));
    tmp.push(site, outDir);
    cpSync(FIXTURE, site, { recursive: true });
    const cfgFile = join(site, 'site.config.json');
    const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
    cfg.contact.webhook = '';
    writeFileSync(cfgFile, JSON.stringify(cfg));
    const overrideFile = join(outDir, 'private-override-name.json');
    writeFileSync(overrideFile, JSON.stringify({ webhook: 'https://hooks.example.test/webhook/override-test' }));
    buildSite({ site, out: join(outDir, 'site'), configOverride: overrideFile });
    const html = read(join(outDir, 'site'), 'index.html');
    expect(html).toContain('action="https://hooks.example.test/webhook/override-test"');
    const everything = [html, read(join(outDir, 'site'), 'landing.js'), read(join(outDir, 'site'), '_headers')].join('\n');
    expect(everything).not.toContain('private-override-name');
  });
});

describe('site-supplied mark and stylesheet', () => {
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" class="mk" role="img" aria-label="Mark"><circle class="m1" cx="5" cy="5" r="3"/></svg>';
  /** Build with the two files written into the copied site. */
  function buildWith(svg: string, css = '.mk .m1 { animation: spin 2s infinite; }'): string {
    const site = mkdtempSync(join(tmpdir(), 'landing-site-'));
    const out = mkdtempSync(join(tmpdir(), 'landing-out-')) + '/site';
    tmp.push(site, join(out, '..'));
    cpSync(FIXTURE, site, { recursive: true });
    const file = join(site, 'site.config.json');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    cfg.markSvg = 'mark-anim.svg';
    cfg.extraCss = 'extra.css';
    writeFileSync(file, JSON.stringify(cfg));
    writeFileSync(join(site, 'mark-anim.svg'), svg);
    writeFileSync(join(site, 'extra.css'), css);
    buildSite({ site, out });
    return out;
  }

  it('inlines the mark where the logo image was, and links the extra stylesheet after landing.css', () => {
    const out = buildWith('<?xml version="1.0"?>\n<!-- note -->\n' + SVG);
    const html = read(out, 'index.html');
    expect(html).toContain('<div class="halo"></div>' + SVG);
    expect(html.split('id="mark"')[1].split('</div>')[0]).not.toContain('<img');
    expect(html).toContain('<link rel="stylesheet" href="/landing.css">\n<link rel="stylesheet" href="/site-extra.css">');
    expect(read(out, 'site-extra.css')).toContain('animation: spin');
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('fails the build for a script, an event handler, an external reference or an inline style in the SVG', () => {
    const bad = (inner: string) => () => buildWith(SVG.replace('<circle', inner + '<circle'));
    expect(bad('<script>alert(1)</script>')).toThrow(/<script> element/);
    expect(bad('<use href="#a"/>')).toThrow(/<use> element/);
    expect(bad('<g onclick="x()"/>')).toThrow(/event-handler attribute \(onclick\)/);
    expect(bad('<g href="https://example.test/x.svg#a"/>')).toThrow(/external reference/);
    expect(bad('<g fill="url(https://example.test/p)"/>')).toThrow(/external reference/);
    expect(bad('<g style="animation-delay:1s"/>')).toThrow(/inline style attribute/);
  });

  it('a site that supplies neither builds exactly as before: the logo image, one stylesheet', () => {
    const out = build();
    const html = read(out, 'index.html');
    expect(html).toContain('<div class="halo"></div><img src="/assets/mark.svg"');
    expect(html).not.toContain('site-extra.css');
    expect(readdirSync(out)).not.toContain('site-extra.css');
  });
});

describe('guided scroll (F274.4.3)', () => {
  // evaluates the very string the browser script ships
  const L = new Function(GUIDE_LOGIC + '; return guideLogic;')() as any;
  const tops = [0, 800, 1700, 2600];
  const maxY = 3100;

  it('picks the next section below the current position, clamped to the end of the page', () => {
    expect(L.nextTarget(tops, 0, maxY)).toBe(800);
    expect(L.nextTarget(tops, 800, maxY)).toBe(1700);
    expect(L.nextTarget(tops, 1000, maxY)).toBe(1700);
    expect(L.nextTarget(tops, 2600, maxY)).toBe(maxY);
    expect(L.nextTarget(tops, 3100, maxY)).toBeNull();
    expect(L.nextTarget([0, 500, 4000], 500, 900)).toBe(900); // last section lower than the page can scroll
  });

  it('starts moving, dwells on arrival, counts down, then moves again; stops at the last section', () => {
    let st = L.start(tops, 0, maxY);
    expect(st).toMatchObject({ mode: 'moving', target: 800 });
    st = L.arrive(800, maxY, 8);
    expect(st).toMatchObject({ mode: 'dwell', left: 8 });
    st = L.tick(st, 3);
    expect(st).toMatchObject({ mode: 'dwell', left: 5 });
    expect(L.tick(st, 5).mode).toBe('moving');
    expect(L.arrive(maxY, maxY, 8).mode).toBe('end');
    expect(L.start(tops, maxY, maxY).mode).toBe('end');
  });

  it('pauses only what is running, and play resumes from the section nearest the top', () => {
    const dwell = L.arrive(800, maxY, 8);
    expect(L.pause(dwell).mode).toBe('paused');
    expect(L.tick(L.pause(dwell), 99).mode).toBe('paused'); // a paused countdown does not run
    expect(L.pause({ mode: 'end', left: 0, target: null }).mode).toBe('end');
    expect(L.resume(tops, 802, maxY, 8)).toMatchObject({ mode: 'dwell', left: 8 }); // on a section: wait it out
    expect(L.resume(tops, 1000, maxY, 8)).toMatchObject({ mode: 'moving', target: 1700 }); // nearest is above: next one
    expect(L.resume(tops, 1600, maxY, 8)).toMatchObject({ mode: 'moving', target: 1700 }); // nearest is below: go to it
    expect(L.resume(tops, maxY, maxY, 8).mode).toBe('end');
  });

  it('is off by default and on, with a dwell, from the config; the hero cue gives way to it', () => {
    expect(parseSiteConfig({ title: 'X' }).guidedScroll).toBeNull();
    expect(parseSiteConfig({ title: 'X', guidedScroll: true }).guidedScroll).toEqual({ dwellSeconds: 8 });
    expect(parseSiteConfig({ title: 'X', guidedScroll: { dwellSeconds: 12 } }).guidedScroll).toEqual({ dwellSeconds: 12 });
    expect(() => parseSiteConfig({ title: 'X', guidedScroll: { dwellSeconds: 1 } })).toThrow(/dwellSeconds/);
    const off = read(build(), 'index.html');
    expect(off).not.toContain('id="guide"');
    expect(off).toContain('class="scroll-cue');
    const on = read(build((c) => { c.guidedScroll = { dwellSeconds: 5 }; }), 'index.html');
    expect(on).toContain('id="guide"');
    expect(on).toContain('data-dwell="5"');
    expect(on).toContain('<button type="button" class="guide-btn" id="guide-go"');
    expect(on).not.toContain('class="scroll-cue');
    expect(on).not.toMatch(/\sstyle="/);
    expect(on).not.toMatch(/<script(?![^>]*\bsrc=)/);
    expect(read(build((c) => { c.guidedScroll = true; }), 'about/index.html')).not.toContain('id="guide"');
  });
});
