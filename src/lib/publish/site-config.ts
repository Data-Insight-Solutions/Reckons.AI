/**
 * Site configuration (F274.4.3) — every brand value a site's pages need, read from
 * <site>/site.config.json so no colour, font, logo, address or webhook is ever written into the
 * engine. The landing layout (site-landing.ts) is generic; this file is what makes it one site's.
 *
 * Validation fails loudly: a mistyped colour or a webhook that is not https stops the build with a
 * message that names the field, instead of silently falling back and shipping the wrong brand.
 * Colour and font values go through the same allow-lists the theme code already uses (output-policy).
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { themeColor, themeFont } from './output-policy';

export const SITE_CONFIG_FILE = 'site.config.json';

/** Colour tokens of one palette (dark or light). Every field is optional in the file. */
export interface Palette {
  bg: string;
  bg2: string;
  panel: string;
  panelStrong: string;
  panelLine: string;
  text: string;
  textSoft: string;
  textMute: string;
  accent: string;
  accentBright: string;
  accent2: string;
  accent2Soft: string;
  accent3: string;
  warm: string;
  warm2: string;
  blobA: string;
  blobB: string;
  blobC: string;
  blobD: string;
  onAccent: string;
  note: string;
  shadow: string;
}

export interface FontFace {
  family: string;
  /** Site-relative path to a self-hosted font file (the page CSP allows fonts from the site only). */
  src: string;
  /** CSS weight or range, e.g. "400" or "300 700". */
  weight: string;
}

export interface SiteConfig {
  title: string;
  description: string | null;
  /** Site-relative image used in the header and as the hero mark. */
  logo: string | null;
  favicon: string | null;
  ogImage: string | null;
  noindex: boolean;
  nav: { label: string; href: string }[];
  cta: { label: string; href: string } | null;
  footer: { text: string; attribution: boolean };
  theme: {
    dark: Palette;
    light: Palette;
    displayFont: string;
    monoFont: string;
    faces: FontFace[];
  };
  contact: {
    /** https URL of the person's own n8n (or similar) webhook. Null: no form, a mailto link. */
    webhook: string | null;
    email: string | null;
    /** The page whose slug equals this gets the form appended. */
    slug: string;
    topics: string[];
    /** `tag` field sent with every submission, so the receiving workflow can tell sites apart. */
    tag: string;
  };
  /** localStorage key remembering the visitor's light or dark choice. */
  themeKey: string;
}

/** Neutral defaults: what a site gets for any value its config leaves out. Not any site's brand. */
export const DEFAULT_DARK: Palette = {
  bg: '#0e1226', bg2: '#151b38', panel: 'rgba(24, 32, 66, .55)', panelStrong: 'rgba(26, 35, 72, .8)',
  panelLine: 'rgba(150, 170, 255, .16)', text: '#eef0fb', textSoft: '#b9c0dc', textMute: '#8891b3',
  accent: '#5b7cfa', accentBright: '#8aa2ff', accent2: '#2fb8a6', accent2Soft: '#7fdccf', accent3: '#a78bfa',
  warm: '#f08aa8', warm2: '#f5b58c',
  blobA: 'rgba(91, 124, 250, .40)', blobB: 'rgba(47, 184, 166, .34)', blobC: 'rgba(167, 139, 250, .32)', blobD: 'rgba(240, 138, 168, .22)',
  onAccent: '#ffffff', note: '#f2b84b', shadow: 'rgba(3, 6, 24, .45)',
};

export const DEFAULT_LIGHT: Palette = {
  bg: '#f6f7fd', bg2: '#eceffb', panel: 'rgba(255, 255, 255, .62)', panelStrong: 'rgba(255, 255, 255, .86)',
  panelLine: 'rgba(50, 70, 150, .13)', text: '#101630', textSoft: '#3b4566', textMute: '#667199',
  accent: '#3d5bd9', accentBright: '#3550c4', accent2: '#12907f', accent2Soft: '#0f7a6c', accent3: '#7c5cf0',
  warm: '#d9567f', warm2: '#e08a4f',
  blobA: 'rgba(91, 124, 250, .34)', blobB: 'rgba(47, 184, 166, .32)', blobC: 'rgba(167, 139, 250, .34)', blobD: 'rgba(240, 138, 168, .30)',
  onAccent: '#ffffff', note: '#b7791f', shadow: 'rgba(40, 55, 120, .14)',
};

const DEFAULT_NAV = [
  { label: 'Home', href: '/' },
  { label: 'Services', href: '/services/' },
  { label: 'About', href: '/about/' },
  { label: 'Blog', href: '/blog/' },
  { label: 'Contact', href: '/contact/' },
];

const DEFAULT_FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
const DEFAULT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const DEFAULT_TOPICS = ['General question', 'A project', 'Something else'];

function fail(msg: string): never {
  throw new Error('site config: ' + msg);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, field: string, max = 200): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') fail(field + ' must be a string');
  const t = v.trim();
  if (t.length > max) fail(field + ' is longer than ' + max + ' characters');
  return t === '' ? null : t;
}

/** A path inside the site (starts with / or is relative) or an https/mailto link. Never javascript:. */
export function safeHref(v: string, field: string): string {
  if (/[\s\\\x00-\x1f\x7f<>"']/.test(v) || v.startsWith('//')) fail(field + ' is not a safe link: ' + v);
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^(https?:|mailto:)/i.test(v)) fail(field + ' must be a site path, http(s) or mailto: ' + v);
  return v;
}

/** A site-relative asset path (no scheme, no traversal). */
export function sitePath(v: string, field: string): string {
  if (/[\s\\\x00-\x1f\x7f<>"'()]/.test(v) || v.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(v) || v.split('/').includes('..')) {
    fail(field + ' must be a site-relative path: ' + v);
  }
  return v.startsWith('/') ? v : '/' + v;
}

function palette(raw: unknown, base: Palette, field: string): Palette {
  if (raw === undefined) return { ...base };
  if (!isObj(raw)) fail(field + ' must be an object of colour values');
  const out = { ...base };
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in base)) fail(field + '.' + k + ' is not a known colour token (known: ' + Object.keys(base).join(', ') + ')');
    if (typeof v !== 'string') fail(field + '.' + k + ' must be a string');
    // themeColor returns the fallback for anything it rejects; a marker fallback reveals the rejection.
    if (themeColor(v, '\u0000') === '\u0000') fail(field + '.' + k + ' is not a plain colour (hex, rgb(), rgba() or a name): ' + v);
    (out as Record<string, string>)[k] = v;
  }
  return out;
}

function fontStack(v: unknown, field: string, fallback: string): string {
  const s = str(v, field);
  if (!s) return fallback;
  if (themeFont(s, '\u0000') === '\u0000') fail(field + ' may contain only letters, digits, blanks, commas, - and _: ' + s);
  return s;
}

/** Validate and normalise a parsed site.config.json. */
export function parseSiteConfig(raw: unknown): SiteConfig {
  if (!isObj(raw)) fail('the file must contain a JSON object');
  const title = str(raw.title, 'title');
  if (!title) fail('title is required');

  const nav = raw.nav === undefined ? DEFAULT_NAV : (() => {
    if (!Array.isArray(raw.nav)) fail('nav must be a list of { label, href }');
    return raw.nav.map((n, i) => {
      if (!isObj(n)) fail('nav[' + i + '] must be { label, href }');
      const label = str(n.label, 'nav[' + i + '].label', 40);
      const href = str(n.href, 'nav[' + i + '].href');
      if (!label || !href) fail('nav[' + i + '] needs a label and an href');
      return { label, href: safeHref(href, 'nav[' + i + '].href') };
    });
  })();

  let cta: SiteConfig['cta'] = null;
  if (raw.cta !== undefined && raw.cta !== null) {
    if (!isObj(raw.cta)) fail('cta must be { label, href }');
    const label = str(raw.cta.label, 'cta.label', 40);
    const href = str(raw.cta.href, 'cta.href');
    if (!label || !href) fail('cta needs a label and an href');
    cta = { label, href: safeHref(href, 'cta.href') };
  }

  const footerRaw = raw.footer === undefined ? {} : raw.footer;
  if (!isObj(footerRaw)) fail('footer must be an object');
  const footer = { text: str(footerRaw.text, 'footer.text', 300) ?? '', attribution: footerRaw.attribution !== false };

  const themeRaw = raw.theme === undefined ? {} : raw.theme;
  if (!isObj(themeRaw)) fail('theme must be an object');
  const facesRaw = themeRaw.fontFaces === undefined ? [] : themeRaw.fontFaces;
  if (!Array.isArray(facesRaw)) fail('theme.fontFaces must be a list');
  const faces: FontFace[] = facesRaw.map((f, i) => {
    if (!isObj(f)) fail('theme.fontFaces[' + i + '] must be { family, src, weight }');
    const family = str(f.family, 'theme.fontFaces[' + i + '].family', 60);
    const src = str(f.src, 'theme.fontFaces[' + i + '].src');
    const weight = str(f.weight, 'theme.fontFaces[' + i + '].weight', 20) ?? '400';
    if (!family || !/^[A-Za-z0-9 _-]+$/.test(family)) fail('theme.fontFaces[' + i + '].family must be letters, digits, blanks, - or _');
    if (!src) fail('theme.fontFaces[' + i + '].src is required');
    if (!/^\d{3}(?: \d{3})?$/.test(weight)) fail('theme.fontFaces[' + i + '].weight must be like "400" or "300 700"');
    return { family, src: sitePath(src, 'theme.fontFaces[' + i + '].src'), weight };
  });

  const contactRaw = raw.contact === undefined ? {} : raw.contact;
  if (!isObj(contactRaw)) fail('contact must be an object');
  let webhook = str(contactRaw.webhook, 'contact.webhook', 500);
  if (webhook) {
    let u: URL;
    try { u = new URL(webhook); } catch { fail('contact.webhook is not a URL: ' + webhook); }
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if (u.protocol !== 'https:' && !local) fail('contact.webhook must be https (or http://localhost for testing)');
    if (u.username || u.password) fail('contact.webhook must not carry credentials');
    webhook = u.toString();
  }
  const email = str(contactRaw.email, 'contact.email', 120);
  if (email && !/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(email)) fail('contact.email is not an email address');
  const topicsRaw = contactRaw.topics === undefined ? DEFAULT_TOPICS : contactRaw.topics;
  if (!Array.isArray(topicsRaw) || topicsRaw.some((t) => typeof t !== 'string' || !t.trim() || t.length > 60)) {
    fail('contact.topics must be a list of short strings');
  }
  const slug = str(contactRaw.slug, 'contact.slug', 60) ?? 'contact';

  const description = str(raw.description, 'description', 300);
  const asset = (v: unknown, f: string) => { const s = str(v, f); return s ? sitePath(s, f) : null; };

  return {
    title,
    description,
    logo: asset(raw.logo, 'logo'),
    favicon: asset(raw.favicon, 'favicon'),
    ogImage: asset(raw.ogImage, 'ogImage'),
    noindex: raw.noindex === true,
    nav,
    cta,
    footer,
    theme: {
      dark: palette(themeRaw.dark, DEFAULT_DARK, 'theme.dark'),
      light: palette(themeRaw.light, DEFAULT_LIGHT, 'theme.light'),
      displayFont: fontStack(themeRaw.displayFont, 'theme.displayFont', DEFAULT_FONT),
      monoFont: fontStack(themeRaw.monoFont, 'theme.monoFont', DEFAULT_MONO),
      faces,
    },
    contact: { webhook, email, slug, topics: (topicsRaw as string[]).map((t) => t.trim()), tag: str(contactRaw.tag, 'contact.tag', 40) ?? 'site' },
    themeKey: str(raw.themeKey, 'themeKey', 60) ?? 'site-theme',
  };
}

/** Read <site>/site.config.json. Null when the site has none (the plain generator layout is used). */
export function loadSiteConfig(site: string, override?: Record<string, unknown>): SiteConfig | null {
  const file = join(site, SITE_CONFIG_FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { fail(SITE_CONFIG_FILE + ' is not valid JSON: ' + (e as Error).message); }
  if (override && raw && typeof raw === 'object') {
    // Build-time override: top-level keys replace the file's. `webhook` is shorthand for contact.webhook,
    // so a private file can hold an address that is never committed.
    const { webhook, ...rest } = override;
    const merged: Record<string, unknown> = { ...(raw as Record<string, unknown>), ...rest };
    if (typeof webhook === 'string') merged.contact = { ...((merged.contact as Record<string, unknown>) ?? {}), webhook };
    raw = merged;
  }
  return parseSiteConfig(raw);
}
