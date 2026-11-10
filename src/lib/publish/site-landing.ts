/**
 * The landing layout (F274.4.3) — one generic design for any Reckons.AI site: a soft drifting colour
 * wash, translucent panels, an asymmetric card grid, reveal on scroll, light and dark, a phone menu
 * and a contact form that posts to the site's own webhook.
 *
 * Nothing here is any site's brand. Colours, fonts, logo, navigation, footer, webhook and address come
 * from <site>/site.config.json (site-config.ts); the words come from the page: a markdown body whose
 * `## ` headings are sections. Sections are plain markdown plus `@key: value` lines under a heading:
 *
 *   ## Heading                          one section; the heading is its title
 *   @section: hero|cards|steps|panels|about|banner|contact|text     (default: text)
 *   @id: anchor                         (default: the heading as a slug)
 *   @eyebrow: Small label above the heading
 *   @intro: One sentence shown beside the heading
 *   ### Item                            one card, step, panel or about block under the section
 *
 * Hero: the heading is the h1 (`==words==` gets the gradient), the first paragraph is the lede, a
 * list of links becomes the buttons (first = primary), `@tagline` sits under the logo mark.
 * Cards: each `###` is a card; its first paragraph is the lead; `Proof: Label | text` adds a proof
 * line, `Stat: 212,000` a large figure, `@tag: alpha` a small tag. Steps: each `###` is a stage of a
 * path that draws itself. Panels: each `###` is a panel; `Price: text` lines become highlighted notes;
 * `@footnote:` goes underneath. About: two columns; a `###` with `@as: timeline` turns its list items
 * ("When | What | Role") into a timeline, any other list becomes chips; `@panel: 1|2` picks the column.
 * Banner: `@date`, the heading, a paragraph and a link button. Contact: the heading and paragraphs,
 * and the form (or a mailto link when no webhook is configured — see site-config.ts).
 *
 * Every page of a configured site shares this shell (header, navigation, footer) so the whole site
 * reads as one; ordinary pages render their markdown inside a panel (renderShellPage). The page's
 * CSP allows scripts and styles from the site itself only — there is no inline script or style — and
 * the contact webhook's origin as the only connection and form target.
 *
 * Pure: strings in, strings out. The generator adds landing.css / landing.js to its output.
 */
import { marked } from 'marked';
import type { SitePage } from '../rdf/page';
import { slugify } from '../rdf/page';
import { sanitizePageHtml } from './output-policy';
import type { Palette, SiteConfig } from './site-config';

export interface ShellContext {
  config: SiteConfig;
  /** Root-absolute URL of the page being rendered, e.g. "/" or "/about/". */
  currentUrl: string;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Block markdown from page content, sanitised like every other page body. */
function block(md: string): string {
  return md.trim() ? sanitizePageHtml(marked.parse(md.trim()) as string) : '';
}

/** Inline markdown (links, emphasis) from page content, sanitised. */
function inline(md: string): string {
  return sanitizePageHtml(marked.parseInline(md.trim()) as string);
}

/** Heading text: `==words==` gets the gradient accent, everything else is inline markdown. */
function heading(md: string): string {
  return md.split(/(==.+?==)/g).map((part) => {
    const m = /^==(.+)==$/.exec(part);
    if (m) return '<span class="grad">' + inline(m[1]) + '</span>';
    // inline() trims; keep the spaces that separate this text from the highlighted words
    return (/^\s/.test(part) ? ' ' : '') + inline(part) + (/\s$/.test(part) && part.trim() ? ' ' : '');
  }).join('');
}

// ── Parsing ──────────────────────────────────────────────────────────────────

export interface LandingSub {
  title: string;
  opts: Record<string, string>;
  /** Markdown body with the option lines removed. */
  body: string;
}

export interface LandingSection {
  title: string;
  opts: Record<string, string>;
  body: string;
  subs: LandingSub[];
}

const OPT_RE = /^@([A-Za-z][\w-]*):\s*(.*)$/;

/** Pull the contiguous `@key: value` lines off the top of a block's lines. */
function takeOpts(lines: string[]): { opts: Record<string, string>; rest: string[] } {
  const opts: Record<string, string> = {};
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === '') { i++; continue; }
    const m = OPT_RE.exec(lines[i]);
    if (!m) break;
    opts[m[1].toLowerCase()] = m[2].trim();
    i++;
  }
  return { opts, rest: lines.slice(i) };
}

/** Split lines on a heading level, ignoring headings inside code fences. */
function splitOn(lines: string[], re: RegExp): { head: string[]; parts: { title: string; lines: string[] }[] } {
  const head: string[] = [];
  const parts: { title: string; lines: string[] }[] = [];
  let fence = false;
  for (const line of lines) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : re.exec(line);
    if (m) parts.push({ title: m[1], lines: [] });
    else (parts.length ? parts[parts.length - 1].lines : head).push(line);
  }
  return { head, parts };
}

/** Split a landing body into sections (`## `) and their items (`### `). Text before the first `## ` is ignored. */
export function parseLanding(body: string): LandingSection[] {
  return splitOn(body.split(/\r?\n/), /^##\s+(.+?)\s*$/).parts.map((raw) => {
    const { opts, rest } = takeOpts(raw.lines);
    const { head, parts } = splitOn(rest, /^###\s+(.+?)\s*$/);
    return {
      title: raw.title,
      opts,
      body: head.join('\n'),
      subs: parts.map((p) => {
        const t = takeOpts(p.lines);
        return { title: p.title, opts: t.opts, body: t.rest.join('\n') };
      }),
    };
  });
}

/** `Key: value` lines removed from a markdown body and returned (case-insensitive key, all matches in order). */
function takeLines(md: string, key: string): { values: string[]; rest: string } {
  const re = new RegExp('^' + key + ':\\s*(.*)$', 'i');
  const values: string[] = [];
  const rest: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) values.push(m[1].trim());
    else rest.push(line);
  }
  return { values, rest: rest.join('\n') };
}

/** The first list's items in a markdown body as [text, href] pairs, with the list removed. */
function takeLinkList(md: string): { links: { text: string; href: string }[]; rest: string } {
  const links: { text: string; href: string }[] = [];
  const rest: string[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = /^\s*[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (m) links.push({ text: m[1], href: m[2] });
    else rest.push(line);
  }
  return { links, rest: rest.join('\n') };
}

/** Allow only site paths, anchors, http(s) and mailto in author-supplied button links. */
function href(h: string): string {
  return /^(\/|#|https?:|mailto:)/i.test(h) && !h.startsWith('//') && !/[\s"'<>\\]/.test(h) ? h : '#';
}

// ── Section rendering ────────────────────────────────────────────────────────

const DELAY = ['', ' d1', ' d2', ' d3'];

function sectionHead(s: LandingSection): string {
  const eyebrow = s.opts.eyebrow ? '<span class="eyebrow">' + esc(s.opts.eyebrow) + '</span>' : '';
  const intro = s.opts.intro ? '<p class="reveal d1">' + inline(s.opts.intro) + '</p>' : '';
  return '<div class="section-head"><div class="reveal">' + eyebrow + '<h2>' + heading(s.title) + '</h2></div>' + intro + '</div>';
}

function wrapSection(s: LandingSection, inner: string, extra = ''): string {
  const id = s.opts.id ? slugify(s.opts.id) : slugify(s.title);
  return '<section id="' + esc(id) + '"' + extra + '><div class="wrap">' + inner + '</div></section>';
}

function renderHero(s: LandingSection, ctx: ShellContext): string {
  const { links, rest } = takeLinkList(s.body);
  const paras = block(rest).replace(/^<p>/, '<p class="lede reveal d2">');
  const buttons = links.length
    ? '<div class="ctas reveal d3">' + links.map((l, i) => '<a class="btn ' + (i === 0 ? 'btn-primary' : 'btn-ghost') + '" href="' + esc(href(l.href)) + '">' + inline(l.text) + '</a>').join('') + '</div>'
    : '';
  const markSrc = s.opts.mark || ctx.config.logo;
  const mark = markSrc
    ? '<div class="mark reveal d1" id="mark"><div class="halo"></div><img src="' + esc(href(markSrc)) + '" alt="' + esc(s.opts['mark-alt'] ?? ctx.config.title) + '">'
      + (s.opts.tagline ? '<div class="tagline">' + esc(s.opts.tagline) + '</div>' : '') + '</div>'
    : '';
  const eyebrow = s.opts.eyebrow ? '<span class="eyebrow reveal">' + esc(s.opts.eyebrow) + '</span>' : '';
  return '<div class="hero"' + (s.opts.id ? ' id="' + esc(slugify(s.opts.id)) + '"' : '') + '><div class="wrap"><div>'
    + eyebrow + '<h1 class="reveal d1">' + heading(s.title) + '</h1>' + paras + buttons
    + '<div class="scroll-cue reveal d5"><span></span>Scroll</div></div>' + mark + '</div></div>';
}

function renderCards(s: LandingSection): string {
  const cards = s.subs.map((sub, i) => {
    const stat = takeLines(sub.body, 'Stat');
    const proof = takeLines(stat.rest, 'Proof');
    let body = block(proof.rest).replace(/^<p>/, '<p class="lead">');
    let proofHtml = '';
    const statHtml = stat.values[0] ? '<div class="stat">' + inline(stat.values[0]) + '</div>' : '';
    const p = proof.values[0];
    if (p || statHtml) {
      const bar = p ? p.indexOf('|') : -1;
      const label = bar > 0 ? '<b>' + esc(p.slice(0, bar).trim()) + '</b>' : '';
      const text = p ? inline(bar > 0 ? p.slice(bar + 1) : p) : '';
      proofHtml = '<div class="proof">' + statHtml + label + text + '</div>';
    }
    const tag = sub.opts.tag ? '<span class="tag">' + esc(sub.opts.tag) + '</span>' : '';
    body = body || '';
    return '<article class="card panel reveal' + (i % 2 ? ' d1' : '') + '"><span class="num">' + String(i + 1).padStart(2, '0') + '</span><h3>' + heading(sub.title) + ' ' + tag + '</h3>' + body + proofHtml + '</article>';
  });
  return sectionHead(s) + '<div class="bento">' + cards.join('\n') + '</div>';
}

function renderSteps(s: LandingSection): string {
  const steps = s.subs.map((sub, i) =>
    '<div class="step reveal' + (DELAY[i % 4] ?? '') + '"><div class="dot panel">' + String(i + 1).padStart(2, '0') + '</div><div><h4>' + heading(sub.title) + '</h4>' + block(sub.body) + '</div></div>');
  return sectionHead(s) + '<div class="path">' + steps.join('\n') + '</div>';
}

function renderPanels(s: LandingSection): string {
  const n = Math.min(Math.max(s.subs.length, 1), 3);
  const panels = s.subs.map((sub, i) => {
    const price = takeLines(sub.body, 'Price');
    const notes = price.values.map((v) => '<div class="price">' + inline(v) + '</div>');
    const noteHtml = notes.length > 1 ? '<div class="options">' + notes.join('') + '</div>' : notes.join('');
    return '<div class="panel reveal' + (DELAY[i % 4] ?? '') + '"><span class="k">' + String(i + 1).padStart(2, '0') + '</span><h3>' + heading(sub.title) + '</h3>' + block(price.rest) + noteHtml + '</div>';
  });
  const foot = s.opts.footnote ? '<p class="footnote reveal">' + inline(s.opts.footnote) + '</p>' : '';
  return sectionHead(s) + '<div class="engage cols-' + n + '">' + panels.join('\n') + '</div>' + foot;
}

/** List items of a markdown body, one string each. */
function listItems(md: string): string[] {
  return md.split(/\r?\n/).map((l) => /^\s*[-*]\s+(.*)$/.exec(l)?.[1]).filter((x): x is string => !!x);
}

function renderAbout(s: LandingSection): string {
  const cols: string[][] = [[], []];
  s.subs.forEach((sub, i) => {
    const col = sub.opts.panel === '2' ? 1 : sub.opts.panel === '1' ? 0 : (i === 0 ? 0 : 1);
    let inner = '<h3>' + heading(sub.title) + '</h3>';
    const items = listItems(sub.body);
    if (sub.opts.as === 'timeline') {
      inner += '<ol class="timeline">' + items.map((it) => {
        const [when, what, role] = it.split('|').map((x) => x.trim());
        return '<li><div class="when">' + inline(when ?? '') + '</div><div class="what">' + inline(what ?? '') + '</div>' + (role ? '<div class="role">' + inline(role) + '</div>' : '') + '</li>';
      }).join('') + '</ol>';
    } else if (items.length > 0 && sub.body.trim().split(/\r?\n/).every((l) => l.trim() === '' || /^\s*[-*]\s/.test(l))) {
      inner += '<div class="chips">' + items.map((it) => '<span class="chip">' + inline(it) + '</span>').join('') + '</div>';
    } else {
      inner += block(sub.body);
    }
    cols[col].push(inner);
  });
  const panels = cols.filter((c) => c.length).map((c, i) => '<div class="panel reveal' + (DELAY[i] ?? '') + '">' + c.join('') + '</div>');
  return sectionHead(s) + '<div class="about">' + panels.join('\n') + '</div>';
}

function renderBanner(s: LandingSection): string {
  const { links, rest } = takeLinkList(s.body);
  const date = s.opts.date ? '<div class="date">' + esc(s.opts.date) + '</div>' : '';
  const btn = links[0] ? '<a class="btn btn-ghost" href="' + esc(href(links[0].href)) + '">' + inline(links[0].text) + '</a>' : '';
  return '<div class="speaking panel reveal"><div>' + date + '<strong>' + heading(s.title) + '</strong>' + block(rest) + '</div>' + btn + '</div>';
}

const FORM_TEXT = {
  name: 'Name', email: 'Email', company: 'Company', topic: 'Topic', message: 'Message',
  send: 'Send message', missing: 'Please add your name, email and a message.',
  sending: 'Sending…', sent: 'Thanks. Your message is on its way.', failed: 'That did not go through. Please try again in a moment.',
};

/** The form when a webhook is configured; otherwise a mailto link; otherwise nothing. */
function contactBlock(config: SiteConfig): string {
  const c = config.contact;
  if (c.webhook) {
    const topics = c.topics.map((t) => '<option>' + esc(t) + '</option>').join('');
    return '<form class="panel reveal d1" id="contact-form" method="post" action="' + esc(c.webhook) + '" data-source="' + esc(c.source) + '"'
      + ' data-missing="' + esc(FORM_TEXT.missing) + '" data-sending="' + esc(FORM_TEXT.sending) + '" data-sent="' + esc(FORM_TEXT.sent) + '" data-failed="' + esc(FORM_TEXT.failed) + '" novalidate>'
      + '<label>' + FORM_TEXT.name + '<input name="name" autocomplete="name" required></label>'
      + '<label>' + FORM_TEXT.email + '<input name="email" type="email" autocomplete="email" required></label>'
      + '<label>' + FORM_TEXT.company + '<input name="company" autocomplete="organization"></label>'
      + '<label>' + FORM_TEXT.topic + '<select name="topic">' + topics + '</select></label>'
      + '<label class="full">' + FORM_TEXT.message + '<textarea name="message" required></textarea></label>'
      + '<label class="hp" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label>'
      + '<div class="full formrow"><button class="btn btn-primary" type="submit">' + FORM_TEXT.send + '</button><span id="form-status" role="status"></span></div></form>';
  }
  if (c.email) {
    return '<div class="panel reveal d1 mailto"><p>No form on this site: write to <a href="mailto:' + esc(c.email) + '">' + esc(c.email) + '</a>.</p></div>';
  }
  return '';
}

function renderContact(s: LandingSection, ctx: ShellContext): string {
  const eyebrow = s.opts.eyebrow ? '<span class="eyebrow">' + esc(s.opts.eyebrow) + '</span>' : '';
  return '<div class="contact"><div class="side reveal">' + eyebrow + '<h2>' + heading(s.title) + '</h2>' + block(s.body) + '</div>' + contactBlock(ctx.config) + '</div>';
}

function renderText(s: LandingSection): string {
  return sectionHead(s) + '<div class="panel prose reveal">' + block(s.body) + '</div>';
}

/** Render one parsed section. */
function renderSection(s: LandingSection, ctx: ShellContext): string {
  switch (s.opts.section) {
    case 'hero': return renderHero(s, ctx);
    case 'cards': return wrapSection(s, renderCards(s));
    case 'steps': return wrapSection(s, renderSteps(s));
    case 'panels': return wrapSection(s, renderPanels(s));
    case 'about': return wrapSection(s, renderAbout(s));
    case 'banner': return wrapSection(s, renderBanner(s), ' class="tight"');
    case 'contact': return wrapSection(s, renderContact(s, ctx));
    default: return wrapSection(s, renderText(s));
  }
}

// ── The shell: head, header, footer ──────────────────────────────────────────

/** The CSP of a configured-site page: this site's own scripts and styles, the webhook as the only outside target. */
export function shellCsp(config: SiteConfig): string {
  const origin = config.contact.webhook ? new URL(config.contact.webhook).origin : "'none'";
  return "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src " + origin
    + '; form-action ' + origin + "; object-src 'none'; base-uri 'none'";
}

function headHtml(title: string, description: string, ctx: ShellContext): string {
  const c = ctx.config;
  const desc = description || c.description || '';
  return '<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="' + esc(shellCsp(c)) + '">\n<meta name="referrer" content="no-referrer">\n'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>' + esc(title) + '</title>\n'
    + (desc ? '<meta name="description" content="' + esc(desc) + '">\n' : '')
    + (c.noindex ? '<meta name="robots" content="noindex">\n' : '')
    + '<meta property="og:title" content="' + esc(c.title) + '">\n'
    + (desc ? '<meta property="og:description" content="' + esc(desc) + '">\n' : '')
    + (c.ogImage ? '<meta property="og:image" content="' + esc(c.ogImage) + '">\n' : '')
    + (c.favicon ? '<link rel="icon" href="' + esc(c.favicon) + '">\n' : '')
    + '<link rel="alternate" type="text/turtle" href="/knowledge.ttl" title="This site as a knowledge graph">\n'
    + '<link rel="stylesheet" href="/landing.css">';
}

function headerHtml(ctx: ShellContext): string {
  const c = ctx.config;
  const links = c.nav.map((n) => {
    const here = n.href === ctx.currentUrl || (n.href !== '/' && ctx.currentUrl.startsWith(n.href));
    return '<a href="' + esc(n.href) + '"' + (here ? ' aria-current="page"' : '') + '>' + esc(n.label) + '</a>';
  }).join('');
  return '<header class="site" id="hdr"><div class="wrap">'
    + '<a class="brand" href="/">' + (c.logo ? '<img src="' + esc(c.logo) + '" alt="">' : '') + esc(c.title) + '</a>'
    + '<nav class="links" id="nav" aria-label="Main">' + links + '</nav>'
    + '<div class="hdr-actions"><button class="icon-btn" id="theme-btn" type="button" aria-label="Switch light or dark">◐</button>'
    + '<button class="icon-btn" id="menu-btn" type="button" aria-label="Menu" aria-controls="nav" aria-expanded="false">☰</button>'
    + (c.cta ? '<a class="btn btn-primary" href="' + esc(c.cta.href) + '">' + esc(c.cta.label) + '</a>' : '')
    + '</div></div></header>';
}

function footerHtml(ctx: ShellContext): string {
  const f = ctx.config.footer;
  return '<footer><div class="wrap"><span>' + esc(f.text) + '</span>'
    + (f.attribution ? '<span>Built with <a href="https://reckons.ai">Reckons.AI</a></span>' : '') + '</div></footer>';
}

function documentHtml(ctx: ShellContext, title: string, description: string, main: string): string {
  return '<!doctype html>\n<html lang="en">\n<head>\n' + headHtml(title, description, ctx) + '\n</head>\n'
    + '<body class="no-js" data-theme-key="' + esc(ctx.config.themeKey) + '">\n'
    + '<div class="aurora" aria-hidden="true"><i class="a"></i><i class="b"></i><i class="c"></i><i class="d"></i></div>\n'
    + headerHtml(ctx) + '\n<main id="top">\n' + main + '\n</main>\n' + footerHtml(ctx) + '\n<script src="/landing.js"></script>\n</body>\n</html>';
}

/** A page whose template is `landing`: its `## ` sections laid out as the landing design. */
export function renderLandingPage(page: SitePage, ctx: ShellContext): string {
  const sections = parseLanding(page.body);
  const main = sections.length
    ? sections.map((s) => renderSection(s, ctx)).join('\n')
    : wrapSection({ title: page.title, opts: {}, body: page.body, subs: [] }, renderText({ title: page.title, opts: {}, body: page.body, subs: [] }));
  return documentHtml(ctx, page.title + ' · ' + ctx.config.title, page.excerpt, main);
}

/** Any other page of a configured site: its markdown in a panel, inside the shared shell. */
export function renderShellPage(page: SitePage, ctx: ShellContext): string {
  const body = page.body?.trim() ? block(page.body) : '<p>' + esc(page.excerpt) + '</p>';
  const date = page.date ? '<time class="date">' + esc(page.date) + '</time>' : '';
  const wantsForm = slugify(page.slug) === slugify(ctx.config.contact.slug);
  const form = wantsForm ? '<div class="page-contact">' + contactBlock(ctx.config) + '</div>' : '';
  const main = '<section class="page"><div class="wrap narrow"><article class="panel prose"><h1>' + esc(page.title) + '</h1>' + date + body + '</article>' + form + '</div></section>';
  return documentHtml(ctx, page.title + ' · ' + ctx.config.title, page.excerpt, main);
}

// ── Stylesheet and script ────────────────────────────────────────────────────

function vars(p: Palette): string {
  return '--bg:' + p.bg + ';--bg-2:' + p.bg2 + ';--panel:' + p.panel + ';--panel-strong:' + p.panelStrong + ';--panel-line:' + p.panelLine
    + ';--text:' + p.text + ';--text-soft:' + p.textSoft + ';--text-mute:' + p.textMute
    + ';--accent:' + p.accent + ';--accent-bright:' + p.accentBright + ';--accent-2:' + p.accent2 + ';--accent-2-soft:' + p.accent2Soft + ';--accent-3:' + p.accent3
    + ';--warm:' + p.warm + ';--warm-2:' + p.warm2
    + ';--blob-a:' + p.blobA + ';--blob-b:' + p.blobB + ';--blob-c:' + p.blobC + ';--blob-d:' + p.blobD
    + ';--on-accent:' + p.onAccent + ';--note:' + p.note + ';--shadow:0 24px 60px ' + p.shadow + ';';
}

const LAYOUT_CSS = `
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 400 17px/1.65 var(--display); -webkit-font-smoothing: antialiased; overflow-x: hidden; }
a { color: var(--accent-bright); text-decoration-thickness: 1px; text-underline-offset: 3px; }
img { max-width: 100%; height: auto; }
.wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 var(--gutter); }
.wrap.narrow { max-width: 860px; }
.eyebrow { display: inline-block; font: 500 12px/1 var(--mono); letter-spacing: .16em; text-transform: uppercase; color: var(--accent-bright); }
h1, h2, h3 { letter-spacing: -.02em; }

/* The background: a soft wash of brand colors that drifts slowly */
.aurora { position: fixed; inset: 0; z-index: -1; overflow: hidden; background: linear-gradient(180deg, var(--bg) 0%, var(--bg-2) 100%); }
.aurora i { position: absolute; border-radius: 50%; filter: blur(90px); will-change: transform; }
.aurora .a { width: 60vmax; height: 60vmax; left: -18vmax; top: -22vmax; background: var(--blob-a); animation: drift-a 46s ease-in-out infinite alternate; }
.aurora .b { width: 55vmax; height: 55vmax; right: -20vmax; top: 4vmax; background: var(--blob-b); animation: drift-b 58s ease-in-out infinite alternate; }
.aurora .c { width: 50vmax; height: 50vmax; left: 18vmax; bottom: -28vmax; background: var(--blob-c); animation: drift-c 64s ease-in-out infinite alternate; }
.aurora .d { width: 34vmax; height: 34vmax; right: 8vmax; bottom: -6vmax; background: var(--blob-d); animation: drift-d 52s ease-in-out infinite alternate; }
@keyframes drift-a { to { transform: translate(14vmax, 10vmax) scale(1.12); } }
@keyframes drift-b { to { transform: translate(-12vmax, 16vmax) scale(.92); } }
@keyframes drift-c { to { transform: translate(-10vmax, -14vmax) scale(1.1); } }
@keyframes drift-d { to { transform: translate(-16vmax, -8vmax) scale(1.18); } }

/* Header */
header.site { position: sticky; top: 0; z-index: 30; transition: background .3s, box-shadow .3s, border-color .3s; border-bottom: 1px solid transparent; }
header.site.scrolled { background: var(--panel-strong); backdrop-filter: blur(16px) saturate(1.3); -webkit-backdrop-filter: blur(16px) saturate(1.3); border-bottom-color: var(--panel-line); }
header.site .wrap { display: flex; align-items: center; gap: 24px; height: 72px; }
.brand { display: flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; font-weight: 600; white-space: nowrap; }
.brand img { width: 42px; height: auto; }
nav.links { display: flex; gap: 28px; margin-left: auto; font-size: 15px; }
nav.links a { color: var(--text-soft); text-decoration: none; }
nav.links a:hover, nav.links a[aria-current="page"] { color: var(--text); }
nav.links a[aria-current="page"] { text-decoration: underline; text-decoration-color: var(--accent-bright); text-underline-offset: 8px; }
.hdr-actions { display: flex; align-items: center; gap: 10px; }
.icon-btn { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 12px; border: 1px solid var(--panel-line); background: var(--panel); color: var(--text); cursor: pointer; font-size: 17px; }
#menu-btn { display: none; }
@media (max-width: 900px) {
  nav.links { display: none; position: absolute; top: 72px; left: var(--gutter); right: var(--gutter); flex-direction: column; gap: 4px; padding: 12px; border-radius: 16px; background: var(--panel-strong); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); border: 1px solid var(--panel-line); box-shadow: var(--shadow); }
  nav.links.open { display: flex; }
  nav.links a { padding: 12px 14px; border-radius: 10px; font-size: 17px; }
  #menu-btn { display: grid; }
  .hdr-actions { margin-left: auto; }
  .hdr-actions .btn { display: none; }
}

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 13px 22px; border-radius: 14px; font: 600 15px/1 var(--display); text-decoration: none; border: 1px solid transparent; cursor: pointer; transition: transform .2s, box-shadow .2s, background .2s; }
.btn:hover { transform: translateY(-2px); }
.btn-primary { background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: var(--on-accent); box-shadow: 0 10px 30px color-mix(in srgb, var(--accent) 35%, transparent); }
.btn-ghost { background: var(--panel); border-color: var(--panel-line); color: var(--text); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }
header .btn { padding: 10px 16px; font-size: 14px; }

/* Panels: translucent, so the color flows behind every section */
.panel { background: var(--panel); border: 1px solid var(--panel-line); border-radius: var(--radius); backdrop-filter: blur(18px) saturate(1.2); -webkit-backdrop-filter: blur(18px) saturate(1.2); box-shadow: var(--shadow); }

/* Hero */
.hero { min-height: calc(100svh - 72px); display: flex; align-items: center; padding: 48px 0 72px; }
.hero .wrap { display: grid; grid-template-columns: 1.15fr .85fr; gap: clamp(24px, 5vw, 80px); align-items: center; width: 100%; }
.hero h1 { font-size: clamp(40px, 6vw, 84px); line-height: 1.02; margin: 18px 0 22px; font-weight: 700; }
.grad { background: linear-gradient(100deg, var(--accent-bright), var(--accent-2-soft) 55%, var(--accent-3)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.hero p.lede { font-size: clamp(17px, 1.5vw, 21px); color: var(--text-soft); max-width: 36em; margin: 0 0 32px; }
.hero .ctas { display: flex; flex-wrap: wrap; gap: 12px; }
.hero .mark { position: relative; }
.hero .mark img { position: relative; display: block; width: 100%; }
.hero .mark .halo { position: absolute; inset: 8%; border-radius: 50%; background: radial-gradient(closest-side, color-mix(in srgb, var(--accent) 30%, transparent), transparent); filter: blur(30px); }
.hero .tagline { text-align: center; margin-top: 10px; font: 500 12px/1 var(--mono); letter-spacing: .32em; text-transform: uppercase; color: var(--text-mute); position: relative; }
.scroll-cue { margin-top: 40px; font: 400 13px/1 var(--mono); color: var(--text-mute); display: inline-flex; gap: 10px; align-items: center; }
.scroll-cue span { width: 1px; height: 28px; background: linear-gradient(var(--accent-bright), transparent); animation: cue 2.4s ease-in-out infinite; }
@keyframes cue { 0%, 100% { transform: scaleY(.4); transform-origin: top; } 50% { transform: scaleY(1); transform-origin: top; } }
@media (max-width: 900px) {
  .hero { min-height: auto; padding: 24px 0 56px; }
  .hero .wrap { grid-template-columns: 1fr; }
  .hero .mark { order: -1; width: min(240px, 60vw); }
  .hero .tagline { text-align: left; letter-spacing: .2em; }
  .scroll-cue { display: none; }
}

/* Sections flow into one another: no rules, generous rhythm */
section { padding: clamp(56px, 9vw, 120px) 0; position: relative; }
section.tight { padding-top: 0; }
.section-head { display: grid; grid-template-columns: 1fr 1fr; gap: 24px 64px; align-items: end; margin-bottom: 40px; }
.section-head h2 { font-size: clamp(30px, 3.8vw, 52px); line-height: 1.06; margin: 14px 0 0; }
.section-head p { color: var(--text-soft); margin: 0; font-size: 18px; max-width: 34em; }
@media (max-width: 900px) { .section-head { grid-template-columns: 1fr; } }

/* Cards: an asymmetric grid, not equal rows (7/5, 5/7, repeating) */
.bento { display: grid; grid-template-columns: repeat(12, 1fr); gap: 20px; }
.bento .card:nth-child(4n+1) { grid-column: span 7; }
.bento .card:nth-child(4n+2) { grid-column: span 5; }
.bento .card:nth-child(4n+3) { grid-column: span 5; }
.bento .card:nth-child(4n+4) { grid-column: span 7; }
@media (max-width: 900px) { .bento .card:nth-child(n) { grid-column: 1 / -1; } }
.card { position: relative; padding: clamp(24px, 3vw, 36px); display: flex; flex-direction: column; overflow: hidden; transition: transform .35s cubic-bezier(.2,.7,.2,1), border-color .35s; }
.card:hover { transform: translateY(-4px); border-color: color-mix(in srgb, var(--accent) 40%, var(--panel-line)); }
.card::before { content: ""; position: absolute; width: 260px; height: 260px; right: -90px; top: -110px; border-radius: 50%; background: var(--glow, var(--blob-a)); filter: blur(50px); opacity: .7; pointer-events: none; }
.card:nth-child(4n+2) { --glow: var(--blob-b); }
.card:nth-child(4n+3) { --glow: var(--blob-c); }
.card:nth-child(4n+4) { --glow: var(--blob-d); }
.card .num { font: 500 12px/1 var(--mono); color: var(--accent-bright); position: relative; }
.card h3 { font-size: clamp(22px, 2vw, 28px); line-height: 1.15; margin: 12px 0 6px; position: relative; }
.card .lead { color: var(--text); font-size: 18px; margin: 0 0 12px; position: relative; }
.card p { color: var(--text-soft); margin: 0 0 14px; position: relative; }
.card ul { margin: 0 0 18px; padding: 0; list-style: none; position: relative; }
.card li { position: relative; padding-left: 20px; color: var(--text-soft); margin: 7px 0; }
.card li::before { content: ""; position: absolute; left: 0; top: .62em; width: 8px; height: 8px; border-radius: 50%; background: linear-gradient(135deg, var(--accent-bright), var(--accent-2)); }
.proof { margin-top: auto; padding-top: 16px; border-top: 1px dashed var(--panel-line); font-size: 15px; color: var(--text-soft); position: relative; }
.proof b { font: 500 11px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--accent-2-soft); display: block; margin-bottom: 7px; }
.tag { display: inline-block; font: 500 11px/1 var(--mono); padding: 5px 8px; border-radius: 7px; border: 1px solid var(--panel-line); color: var(--text-mute); margin-left: 8px; vertical-align: middle; }
.tag:empty { display: none; }
.stat { font-size: clamp(34px, 3.4vw, 46px); font-weight: 700; line-height: 1; background: linear-gradient(100deg, var(--warm), var(--warm-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }

/* Steps: a path that draws itself as you scroll */
.path { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; position: relative; }
.path::before { content: ""; position: absolute; left: 6%; right: 6%; top: 34px; height: 2px; background: linear-gradient(90deg, var(--accent-bright), var(--accent-2-soft), var(--accent-3)); transform: scaleX(var(--draw, 0)); transform-origin: left; transition: transform 1.4s cubic-bezier(.2,.7,.2,1); opacity: .7; }
.path.in { --draw: 1; }
.path .step { padding: 0 6px; }
.path .dot { width: 68px; height: 68px; border-radius: 50%; display: grid; place-items: center; font: 500 13px/1 var(--mono); color: var(--accent-bright); margin-bottom: 18px; position: relative; }
.path h4 { margin: 0 0 8px; font-size: 20px; }
.path p { margin: 0; color: var(--text-soft); }
@media (max-width: 900px) {
  .path { grid-template-columns: 1fr; gap: 28px; }
  .path::before { left: 33px; right: auto; top: 34px; bottom: 34px; width: 2px; height: auto; transform: scaleY(var(--draw, 0)); transform-origin: top; background: linear-gradient(180deg, var(--accent-bright), var(--accent-3)); }
  .path .step { display: grid; grid-template-columns: 68px 1fr; gap: 18px; padding: 0; }
  .path .dot { margin: 0; }
}

/* Panels in a row */
.engage { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 20px; }
.engage.cols-3 { grid-template-columns: 1fr 1fr 1.25fr; }
@media (max-width: 1000px) { .engage.cols-3 { grid-template-columns: 1fr; } }
.engage .panel { padding: 28px; }
.engage .k { font: 500 12px/1 var(--mono); color: var(--accent-bright); }
.engage h3 { margin: 12px 0 8px; font-size: 22px; }
.engage p { margin: 0 0 10px; color: var(--text-soft); }
.engage .price { margin-top: 14px; padding: 14px 16px; border-radius: 14px; background: color-mix(in srgb, var(--accent) 10%, transparent); border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent); font-size: 15px; color: var(--text); }
.engage .price b, .engage .price strong { font-family: var(--mono); font-weight: 500; }
.engage .options { display: grid; gap: 12px; margin-top: 12px; }
.engage .options .price { margin-top: 0; }
.footnote { margin-top: 22px; color: var(--text-mute); font-size: 15px; }

/* About */
.about { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
@media (max-width: 900px) { .about { grid-template-columns: 1fr; } }
.about .panel { padding: clamp(24px, 3vw, 36px); }
.timeline { list-style: none; margin: 18px 0 0; padding: 0; position: relative; }
.timeline::before { content: ""; position: absolute; left: 5px; top: 8px; bottom: 8px; width: 2px; background: linear-gradient(var(--accent-bright), var(--accent-3)); opacity: .5; }
.timeline li { position: relative; padding: 0 0 20px 28px; }
.timeline li::before { content: ""; position: absolute; left: 0; top: .45em; width: 12px; height: 12px; border-radius: 50%; background: var(--bg); border: 2px solid var(--accent-bright); }
.timeline li:first-child::before { background: var(--accent-bright); box-shadow: 0 0 0 5px color-mix(in srgb, var(--accent) 25%, transparent); }
.timeline .when { font: 400 13px/1.4 var(--mono); color: var(--text-mute); }
.timeline .what { font-weight: 600; font-size: 18px; }
.timeline .role { color: var(--text-soft); font-size: 15px; }
.about h3 { font: 500 12px/1 var(--mono); letter-spacing: .14em; text-transform: uppercase; color: var(--accent-2-soft); margin: 0 0 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 26px; }
.chip { font-size: 14.5px; padding: 9px 14px; border-radius: 999px; border: 1px solid var(--panel-line); color: var(--text-soft); background: color-mix(in srgb, var(--panel) 80%, transparent); }
.chip a { color: inherit; text-decoration: none; }
.chip a:hover { color: var(--accent-bright); }

/* Banner */
.speaking { display: flex; gap: 24px; align-items: center; justify-content: space-between; flex-wrap: wrap; padding: 26px 30px; }
.speaking .date { font: 500 13px/1.5 var(--mono); color: var(--accent-bright); }
.speaking strong { font-size: 20px; }
.speaking p { margin: 4px 0 0; color: var(--text-soft); max-width: 46em; }

/* Contact */
.contact { display: grid; grid-template-columns: .9fr 1.1fr; gap: clamp(24px, 5vw, 72px); align-items: start; }
@media (max-width: 900px) { .contact { grid-template-columns: 1fr; } }
.contact h2 { font-size: clamp(32px, 4vw, 54px); line-height: 1.05; margin: 14px 0 16px; }
.contact .side p { color: var(--text-soft); font-size: 18px; }
form.panel, .mailto { padding: clamp(22px, 3vw, 34px); }
form.panel { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
form .full { grid-column: 1 / -1; }
@media (max-width: 560px) { form.panel { grid-template-columns: 1fr; } }
label { display: grid; gap: 6px; font-size: 14px; color: var(--text-soft); }
input, select, textarea { width: 100%; font: 400 16px/1.4 var(--display); color: var(--text); background: color-mix(in srgb, var(--bg) 55%, transparent); border: 1px solid var(--panel-line); border-radius: 12px; padding: 12px 14px; }
textarea { min-height: 140px; resize: vertical; }
input:focus, select:focus, textarea:focus { outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent); outline-offset: 1px; }
.hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.formrow { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
#form-status { min-height: 1.4em; font-size: 15px; }
#form-status.ok { color: var(--accent-bright); }
#form-status.err { color: var(--warm); }

/* Ordinary pages in the same shell */
section.page { padding-top: clamp(24px, 4vw, 56px); }
.prose { padding: clamp(24px, 4vw, 48px); }
.prose h1 { font-size: clamp(30px, 4vw, 48px); line-height: 1.08; margin: 0 0 18px; }
.prose h2 { margin-top: 2rem; }
.prose p, .prose li { color: var(--text-soft); }
.prose .date { color: var(--text-mute); font: 400 13px/1 var(--mono); display: block; margin-bottom: 18px; }
.prose img { border-radius: 12px; }
.prose pre { background: color-mix(in srgb, var(--bg) 55%, transparent); padding: 1rem; border-radius: 12px; overflow: auto; }
.prose code { font-family: var(--mono); font-size: .92em; }
.prose table { border-collapse: collapse; display: block; overflow-x: auto; }
.prose th, .prose td { border: 1px solid var(--panel-line); padding: 6px 10px; }
.page-contact { margin-top: 20px; }
.page-contact form.panel { grid-template-columns: 1fr 1fr; }

footer { padding: 40px 0 56px; color: var(--text-mute); font-size: 14px; }
footer .wrap { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
footer a { color: var(--text-soft); }

/* Scroll reveals: gentle, once, and off for reduced motion */
.reveal { opacity: 0; transform: translateY(28px); transition: opacity .9s cubic-bezier(.2,.7,.2,1), transform .9s cubic-bezier(.2,.7,.2,1); transition-delay: var(--d, 0s); }
.reveal.in { opacity: 1; transform: none; }
.no-js .reveal { opacity: 1; transform: none; }
.d1 { --d: .08s; } .d2 { --d: .16s; } .d3 { --d: .24s; } .d4 { --d: .32s; } .d5 { --d: .4s; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; }
  html { scroll-behavior: auto; }
  .reveal { opacity: 1; transform: none; }
  .path { --draw: 1; }
}
`;

/** landing.css: the site's palettes and fonts (from config) over the fixed layout. */
export function landingCss(config: SiteConfig): string {
  const t = config.theme;
  const faces = t.faces.map((f) => '@font-face{font-family:' + f.family + ';src:url(' + f.src + ') format("woff2");font-weight:' + f.weight + ';font-style:normal;font-display:swap}').join('\n');
  const light = vars(t.light);
  return (faces ? faces + '\n' : '')
    + ':root{' + vars(t.dark) + '--display:' + t.displayFont + ';--mono:' + t.monoFont + ';--wrap:1320px;--gutter:clamp(16px,4vw,56px);--radius:22px;color-scheme:dark}\n'
    + '@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){' + light + 'color-scheme:light}}\n'
    + ':root[data-theme="light"]{' + light + 'color-scheme:light}\n'
    + LAYOUT_CSS;
}

/** landing.js: theme toggle, phone menu, header on scroll, reveal on scroll, contact form post. */
export function landingJs(): string {
  return `(function () {
  'use strict';
  var root = document.documentElement;
  var key = document.body.getAttribute('data-theme-key') || 'site-theme';
  document.body.classList.remove('no-js');
  try { var saved = localStorage.getItem(key); if (saved) root.setAttribute('data-theme', saved); } catch (e) {}

  var themeBtn = document.getElementById('theme-btn');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var cur = root.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem(key, next); } catch (e) {}
  });

  var nav = document.getElementById('nav'), menu = document.getElementById('menu-btn');
  if (nav && menu) {
    menu.addEventListener('click', function () { var open = nav.classList.toggle('open'); menu.setAttribute('aria-expanded', String(open)); });
    nav.addEventListener('click', function (e) { if (e.target && e.target.tagName === 'A') { nav.classList.remove('open'); menu.setAttribute('aria-expanded', 'false'); } });
  }

  var hdr = document.getElementById('hdr'), mark = document.getElementById('mark');
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  addEventListener('scroll', function () {
    if (hdr) hdr.classList.toggle('scrolled', scrollY > 8);
    if (mark && !reduce && scrollY < innerHeight) mark.style.translate = '0 ' + (scrollY * 0.12) + 'px';
  }, { passive: true });

  var targets = document.querySelectorAll('.reveal, .path');
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { threshold: 0.06, rootMargin: '0px 0px -24px 0px' });
    targets.forEach(function (el) { io.observe(el); });
  } else {
    targets.forEach(function (el) { el.classList.add('in'); });
  }

  var form = document.getElementById('contact-form'), status = document.getElementById('form-status');
  if (form && status) form.addEventListener('submit', function (e) {
    e.preventDefault();
    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    var say = function (cls, msg) { status.className = cls; status.textContent = msg; };
    if (!data.name || !data.email || !data.message) { say('err', form.getAttribute('data-missing')); return; }
    data.source = form.getAttribute('data-source') || 'site';
    say('', form.getAttribute('data-sending'));
    fetch(form.action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (res) { return res.json().catch(function () { return {}; }).then(function (out) { return { ok: res.ok, out: out }; }); })
      .then(function (r) {
        if (r.ok && r.out.ok !== false) { say('ok', form.getAttribute('data-sent')); form.reset(); }
        else say('err', r.out.error || form.getAttribute('data-failed'));
      })
      .catch(function () { say('err', form.getAttribute('data-failed')); });
  });
})();
`;
}
