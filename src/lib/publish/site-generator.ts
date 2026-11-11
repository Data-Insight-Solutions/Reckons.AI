/**
 * Standalone static-site generator (F76) — turn the graph's WebPage nodes into SELF-CONTAINED HTML
 * that any static host serves with no framework and no build step (Matt, 2026-07-16: pre-built HTML).
 *
 * Distinct from site-export.ts, which emits the CONTENT SOURCE (content/*.md + Sveltia admin) that
 * the main app's SvelteKit build renders at /docs. That source is not viewable on its own. This
 * produces the finished site: one HTML file per page (marked-rendered body + nav + prev/next), one
 * stylesheet, and graph.json — droppable onto Cloudflare Pages, Netlify, GitHub/GitLab Pages, or a
 * folder, and reachable by the `reckons publish` CLI which then runs the host's deploy tool.
 *
 * Pure: statements in, a path→content map out. No DOM, no network — testable and runnable in the CLI.
 */
import { marked } from 'marked';
import type { Statement } from '../rdf/types';
import { buildSitePages, publishablePages, slugify, type SitePage } from '../rdf/page';
import { buildGraphJson } from './site-export';
import { assertSitePath } from './output-path';
import { localImageUrl, sanitizePageHtml, STATIC_SITE_CSP, themeColor, themeFont } from './output-policy';

marked.setOptions({ gfm: true, breaks: false });

export interface GenerateSiteOptions {
  siteTitle?: string;
  siteDescription?: string;
  /** F274.4.2: blog behavior (index, categories, post extras), built by site-blog.ts. */
  extension?: SiteExtension;
  /**
   * LOCAL PREVIEW ONLY (F274.4.2): include draft pages with a visible "Draft" marker and a noindex
   * meta on every page. Never turn this on for a build that will be deployed; site-build.ts stamps the
   * output so the publish paths can refuse it.
   */
  includeDrafts?: boolean;
}

/** A page the extension adds that is not a WebPage (the blog index, a category page). */
export interface ExtraPage {
  /** Output file path, e.g. 'blog/index.html'. */
  path: string;
  title: string;
  description?: string;
  /** TRUSTED html, already escaped/sanitized by the extension. */
  html: string;
}

/**
 * Hooks a feature module registers with the generator without the generator knowing its
 * rules (the blog is the first user). Every html string returned is trusted: the extension
 * must escape and sanitize what it builds.
 */
export interface SiteExtension {
  /** Called once with the pages about to be rendered; may return them with prev/next rewritten. */
  preparePages?(pages: SitePage[]): SitePage[];
  /** Pages left out of the sidebar nav (e.g. posts). */
  hiddenFromNav?(page: SitePage): boolean;
  /** Extra sidebar links, shown after the pages. */
  navLinks?(): Array<{ href: string; label: string }>;
  /** Html placed between the page's date line and its body. */
  beforeBody?(page: SitePage): string;
  /** Html placed after the page body, still inside the article. */
  afterBody?(page: SitePage): string;
  /** Extra generated pages. */
  extraPages?(pages: SitePage[]): ExtraPage[];
  /** Extra CSS appended to styles.css. */
  css?(): string;
  /** URL the root redirects to when no non-post page can be the home (e.g. '/blog/'). */
  rootRedirect?(): string | null;
}

const SITE = 'urn:reckons:site/';
const SITE_THEME_TYPE = 'urn:kbase:type/SiteTheme';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * The site's DESIGN, read from the graph (Matt, 2026-07-16: "a Logo entity, an image, theme and
 * style preferences, a colour palette... generation happens from there"). A ktype:SiteTheme entity
 * carries these as urn:reckons:site/* facts; anything unset falls back to a sensible dark default,
 * so a graph with no theme still produces a clean site.
 */
export interface SiteTheme {
  title: string | null;
  logoUrl: string | null;
  bg: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
  line: string;
  font: string;
}

const DEFAULT_THEME: SiteTheme = {
  title: null,
  logoUrl: null,
  bg: '#0d1117',
  surface: '#131a24',
  ink: '#e8eaf0',
  muted: '#9aa4b2',
  accent: '#f59e0b',
  line: 'rgba(255,255,255,.1)',
  font: 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
};

/** Read the site theme from a ktype:SiteTheme entity, falling back to the default per-field. */
export function extractTheme(stmts: Statement[]): SiteTheme {
  const themeIri = stmts.find((s) => s.p.value === RDF_TYPE && s.o.value === SITE_THEME_TYPE)?.s.value;
  if (!themeIri) return { ...DEFAULT_THEME };
  const val = (pred: string): string | null =>
    stmts.find((s) => s.s.value === themeIri && s.p.value === `${SITE}${pred}`)?.o.value ?? null;
  return {
    title: val('title'),
    logoUrl: localImageUrl(val('logo')),
    bg: themeColor(val('bg'), DEFAULT_THEME.bg),
    surface: themeColor(val('surface'), DEFAULT_THEME.surface),
    ink: themeColor(val('ink'), DEFAULT_THEME.ink),
    muted: themeColor(val('muted'), DEFAULT_THEME.muted),
    accent: themeColor(val('accent'), DEFAULT_THEME.accent),
    line: themeColor(val('line'), DEFAULT_THEME.line),
    font: themeFont(val('font'), DEFAULT_THEME.font),
  };
}

export interface GeneratedSite {
  /** path -> file content (HTML, CSS, JSON). */
  files: Record<string, string>;
  pageCount: number;
  /** IRI of the page used as the home, or null. */
  homeIri: string | null;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Root-absolute URL for a page. Home → '/'; else /<section>/<slug>/. */
function pageUrl(page: SitePage, homeIri: string | null): string {
  assertSitePath(page.slug);
  if (page.iri === homeIri) return '/';
  const seg = page.section ? `${slugify(page.section)}/` : '';
  return `/${assertSitePath(`${seg}${page.slug}`)}/`;
}

/** Output file path for a page (clean URLs via directory index.html). */
function pagePath(page: SitePage, homeIri: string | null): string {
  const url = pageUrl(page, homeIri);
  return url === '/' ? 'index.html' : `${url.slice(1)}index.html`;
}

/** The home page: the first 'landing'-template page, else the lowest-order root page, else first. */
function pickHome(allPages: SitePage[]): SitePage | null {
  // A post is never the home page (F274.4.2): the blog index lives at /blog/, not at '/'.
  const pages = allPages.filter((p) => p.template !== 'post');
  if (pages.length === 0) return null;
  return (
    pages.find((p) => p.template === 'landing') ??
    [...pages].filter((p) => !p.parent).sort((a, b) => a.order - b.order)[0] ??
    pages[0]
  );
}

function navHtml(pages: SitePage[], current: SitePage, homeIri: string | null, ext?: SiteExtension): string {
  // Group by section; ungrouped first. Ordered by page.order within a section.
  const sections = new Map<string, SitePage[]>();
  for (const p of [...pages].sort((a, b) => a.order - b.order)) {
    if (ext?.hiddenFromNav?.(p)) continue;
    const key = p.section || '';
    (sections.get(key) ?? sections.set(key, []).get(key)!).push(p);
  }
  const parts: string[] = [];
  for (const [section, ps] of sections) {
    if (section) parts.push(`<div class="nav-section">${escapeHtml(section)}</div>`);
    for (const p of ps) {
      const active = p.iri === current.iri ? ' class="active"' : '';
      parts.push(`<a href="${pageUrl(p, homeIri)}"${active}>${escapeHtml(p.title)}</a>`);
    }
  }
  for (const l of ext?.navLinks?.() ?? []) {
    const active = current.slug === 'blog' && current.section === '' && l.href === '/blog/' ? ' class="active"' : '';
    parts.push(`<a href="${escapeHtml(l.href)}"${active}>${escapeHtml(l.label)}</a>`);
  }
  return parts.join('\n');
}

function renderPage(
  page: SitePage, pages: SitePage[], homeIri: string | null, theme: SiteTheme, opts: GenerateSiteOptions,
  extra?: { html: string },
): string {
  const ext = opts.extension;
  const byIri = new Map(pages.map((p) => [p.iri, p]));
  const body = extra
    ? extra.html
    : page.body?.trim() ? sanitizePageHtml(marked.parse(page.body) as string) : `<p>${escapeHtml(page.excerpt)}</p>`;
  const draftBanner = page.status === 'draft' && opts.includeDrafts
    ? '<p class="draft-banner">Draft: local preview only, not published.</p>' : '';
  const robots = opts.includeDrafts ? '<meta name="robots" content="noindex, nofollow">' : '';
  const prev = page.prev ? byIri.get(page.prev) : null;
  const next = page.next ? byIri.get(page.next) : null;
  const nav = `
    <nav class="pager">
      ${prev ? `<a class="prev" href="${pageUrl(prev, homeIri)}">← ${escapeHtml(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a class="next" href="${pageUrl(next, homeIri)}">${escapeHtml(next.title)} →</a>` : '<span></span>'}
    </nav>`;
  const siteTitle = escapeHtml(theme.title ?? opts.siteTitle ?? 'Reckons.AI site');
  const brand = theme.logoUrl
    ? `<img class="site-logo" src="${escapeHtml(theme.logoUrl)}" alt="${siteTitle}">`
    : siteTitle;
  const dateLine = page.date ? `<time class="date">${escapeHtml(page.date)}</time>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${STATIC_SITE_CSP}">
<meta name="referrer" content="no-referrer">
${robots}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)} · ${siteTitle}</title>
${page.excerpt ? `<meta name="description" content="${escapeHtml(page.excerpt)}">` : ''}
<link rel="alternate" type="text/turtle" href="/knowledge.ttl" title="This site as a knowledge graph">
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="layout">
  <aside class="sidebar">
    <a class="site-title" href="/">${brand}</a>
    <nav class="site-nav">${navHtml(pages, page, homeIri, ext)}</nav>
  </aside>
  <main id="main" class="content template-${page.template}">
    <article>
      ${draftBanner}
      <h1>${escapeHtml(page.title)}</h1>
      ${dateLine}
      ${extra ? '' : ext?.beforeBody?.(page) ?? ''}
      ${body}
      ${extra ? '' : ext?.afterBody?.(page) ?? ''}
    </article>
    ${prev || next ? nav : ''}
  </main>
</div>
<footer class="site-footer">Published from a <a href="/knowledge.ttl">knowledge graph</a> with Reckons.AI.</footer>
</body>
</html>`;
}

function stylesFor(theme: SiteTheme, extraCss = ''): string {
  return `:root{--bg:${theme.bg};--surface:${theme.surface};--ink:${theme.ink};--muted:${theme.muted};--line:${theme.line};--accent:${theme.accent}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 ${theme.font}}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.skip{position:absolute;left:-9999px}.skip:focus{left:8px;top:8px;background:var(--surface);padding:.5rem;border-radius:6px}
.layout{display:flex;min-height:100vh;max-width:1100px;margin:0 auto}
.sidebar{width:240px;flex:0 0 240px;padding:1.5rem 1rem;border-right:1px solid var(--line);position:sticky;top:0;height:100vh;overflow:auto}
.site-title{display:block;font-weight:700;font-size:1.1rem;margin-bottom:1rem;color:var(--ink)}
.site-nav a{display:block;padding:.25rem 0;color:var(--muted)}.site-nav a.active{color:var(--accent);font-weight:600}
.nav-section{margin:1rem 0 .25rem;font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);opacity:.7}
.content{flex:1;min-width:0;padding:2rem 2.5rem;max-width:760px}
.content h1{margin:.2rem 0 1rem;font-size:2rem}.content h2{margin-top:2rem}.content img{max-width:100%;height:auto;border-radius:8px}
.content pre{background:var(--surface);padding:1rem;border-radius:8px;overflow:auto}.content code{background:var(--surface);padding:.1rem .3rem;border-radius:4px}
.content pre code{padding:0;background:none}.date{color:var(--muted);font-size:.85rem}
.pager{display:flex;justify-content:space-between;gap:1rem;margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line)}
.site-footer{text-align:center;color:var(--muted);font-size:.8rem;padding:2rem;border-top:1px solid var(--line)}
.site-logo{max-width:160px;max-height:64px;margin-bottom:.75rem;display:block}
@media(max-width:720px){.layout{flex-direction:column}.sidebar{width:auto;flex:none;height:auto;position:static;border-right:none;border-bottom:1px solid var(--line)}.content{padding:1.5rem}}${extraCss ? '\n' + extraCss : ''}`;
}

/** The root page of a site with no home page: a redirect to the blog index, or a plain page list. */
function rootStub(pages: SitePage[], redirect: string | null, theme: SiteTheme, opts: GenerateSiteOptions): string {
  const siteTitle = escapeHtml(theme.title ?? opts.siteTitle ?? 'Reckons.AI site');
  const refresh = redirect ? `<meta http-equiv="refresh" content="0; url=${escapeHtml(redirect)}">` : '';
  const robots = opts.includeDrafts ? '<meta name="robots" content="noindex, nofollow">' : '';
  const list = redirect
    ? `<p><a href="${escapeHtml(redirect)}">Continue to the blog</a></p>`
    : `<ul>${pages.map((p) => `<li><a href="${pageUrl(p, null)}">${escapeHtml(p.title)}</a></li>`).join('')}</ul>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${STATIC_SITE_CSP}">
<meta name="referrer" content="no-referrer">
${robots}
${refresh}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${siteTitle}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body>
<main class="content"><h1>${siteTitle}</h1>${list}</main>
</body>
</html>`;
}

/**
 * Build the finished static site from the graph. `home` picks the landing page; every published
 * WebPage becomes a clean-URL HTML file; one stylesheet and graph.json round it out.
 */
export function generateStaticSite(stmts: Statement[], opts: GenerateSiteOptions = {}): GeneratedSite {
  const all = buildSitePages(stmts);
  const ext = opts.extension;
  const selected = opts.includeDrafts ? all : publishablePages(all);
  const pages = ext?.preparePages ? ext.preparePages(selected) : selected;
  const home = pickHome(pages);
  const homeIri = home?.iri ?? null;
  const theme = extractTheme(stmts);

  const files: Record<string, string> = {};
  for (const page of pages) {
    const output = pagePath(page, homeIri);
    if (Object.hasOwn(files, output)) throw new Error('Duplicate site output path');
    files[output] = renderPage(page, pages, homeIri, theme, opts);
  }
  for (const x of ext?.extraPages?.(pages) ?? []) {
    if (Object.hasOwn(files, x.path)) throw new Error('Duplicate site output path');
    const synthetic: SitePage = {
      iri: 'urn:reckons:site-extra/' + x.path, title: x.title, slug: x.path.replace(/\/?index\.html$/, '').replace(/\//g, '-'),
      section: '', order: 0, parent: null, template: 'full', status: 'published', nav: 'hidden',
      excerpt: x.description ?? '', body: '', related: [], next: null, prev: null, date: null,
    };
    files[x.path] = renderPage(synthetic, pages, homeIri, theme, opts, { html: x.html });
  }
  // No home (a site of only posts): '/' is never a post. Send it to the blog index when there is
  // one, else to a plain list, so the site still has a root.
  if (!files['index.html'] && pages.length > 0) {
    files['index.html'] = rootStub(pages, ext?.rootRedirect?.() ?? null, theme, opts);
  }
  files['styles.css'] = stylesFor(theme, ext?.css?.());
  files['graph.json'] = JSON.stringify(buildGraphJson(pages), null, 2);

  return { files, pageCount: pages.length, homeIri };
}

/**
 * The SHELL signature — everything shared across every page (theme + the nav: each page's title,
 * slug, section, order). If this is unchanged between two graph states, a content-only edit needs
 * ONLY the changed page(s) rewritten; if it changed, the nav/theme moved and every page must be
 * regenerated for consistency. This is what makes "don't regenerate the whole site every time"
 * (Matt) safe: targeted updates when the shell is stable, full regen when the design/structure moves.
 */
export function siteShellSignature(stmts: Statement[]): string {
  const pages = publishablePages(buildSitePages(stmts));
  const nav = pages
    .map((p) => `${p.order}|${p.section}|${p.slug}|${p.title}|${p.template}|${p.prev}|${p.next}`)
    .sort()
    .join('\n');
  return `${JSON.stringify(extractTheme(stmts))}\n${nav}`;
}

/**
 * Targeted regeneration: rebuild ONLY the HTML for the named pages (plus graph.json, which is cheap
 * and must stay in sync), reusing the full page list so nav/links resolve. Use when the shell
 * signature is unchanged and only some page BODIES changed — write these files, leave the rest of
 * the deployed site untouched. If the shell moved, call generateStaticSite instead (full rebuild).
 */
export function regenerateChangedPages(
  stmts: Statement[],
  changedIris: Iterable<string>,
  opts: GenerateSiteOptions = {},
): { files: Record<string, string>; regenerated: string[] } {
  const pages = publishablePages(buildSitePages(stmts));
  const home = pickHome(pages);
  const homeIri = home?.iri ?? null;
  const theme = extractTheme(stmts);
  const changed = new Set(changedIris);
  const allPaths = pages.map(p => pagePath(p, homeIri));
  if (new Set(allPaths).size !== allPaths.length) throw new Error('Duplicate site output path');

  const files: Record<string, string> = {};
  const regenerated: string[] = [];
  for (const page of pages) {
    if (!changed.has(page.iri)) continue;
    const path = pagePath(page, homeIri);
    files[path] = renderPage(page, pages, homeIri, theme, opts);
    regenerated.push(path);
  }
  // graph.json describes the whole site's pages — keep it current whenever anything is republished.
  files['graph.json'] = JSON.stringify(buildGraphJson(pages), null, 2);
  return { files, regenerated };
}
