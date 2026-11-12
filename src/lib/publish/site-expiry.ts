/**
 * Facts that expire (F293) — a list entry on a site page may say when it stops being true.
 *
 *   - AWS Certified Solutions Architect – Associate | valid-until: 2027-12-31
 *   - Some other credential | valid-until: ?
 *
 * `valid-until: YYYY-MM-DD` is a fact with that date. `valid-until: ?` is an OPEN QUESTION in the house
 * partial-fact form (src/lib/rdf/partial-facts.ts): subject known, predicate known, object open. A past
 * date is never a guess: nothing is expired unless its own date has passed, and the check never infers a
 * lifetime from a type of credential. An entry with no marker never expires.
 *
 * Pure functions, no file access and no clock of their own (callers pass `today`), so the same input gives
 * the same output. The page text keeps its entry; the marker is removed before the page is rendered
 * (stripExpiryMarkers) so a visitor never sees it.
 *
 * Predicate: kpred:valid-until, declared in static/reckons-vocabulary.ttl with skos:closeMatch to
 * schema:validThrough. The local term is used in the data because schema:validThrough's declared domain is
 * offers and similar, not any fact; the vocabulary records the link.
 */
import { createHash } from 'node:crypto';
import { parsePageFile } from './site-import';

export const VALID_UNTIL_PREDICATE = 'urn:kbase:predicate/valid-until';
export const STATED_ON_PREDICATE = 'urn:kbase:predicate/stated-on';
export const FACTS_FILE = '.reckons-site-facts.json';
export const FACTS_FORMAT = 'reckons-site-facts-v1';
export const DEFAULT_WARNING_DAYS = 60;

const MARKER = /^valid-until\s*:\s*(.*)$/i;
const LIST_LINE = /^(\s*[-*]\s+)(.*)$/;

export interface ExpiryMarker {
  /** The entry's own words, without the marker or any logo segment, links and emphasis flattened to text. */
  text: string;
  /** YYYY-MM-DD, or null when the date is open (`?`). */
  validUntil: string | null;
  /** 1-based line within the page body. */
  line: number;
}

export interface ExpiryFact {
  /** Stable id from the fact's text, the same on every page that states it. */
  id: string;
  label: string;
  validUntil: string | null;
  /** Every page that states it: slug, and the public path the site serves it at. */
  pages: { slug: string; path: string }[];
}

export type ExpiryState = 'expired' | 'warning' | 'open' | 'ok';

export interface ExpiryReport {
  today: string;
  windowDays: number;
  expired: (ExpiryFact & { daysAgo: number })[];
  warning: (ExpiryFact & { daysLeft: number })[];
  open: ExpiryFact[];
  ok: ExpiryFact[];
}

function isCalendarDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Links and emphasis flattened to their words, so one fact reads the same wherever it is written. */
function plain(s: string): string {
  return s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim();
}

/** Split a list entry on its `|` separators; a segment that is the marker is returned apart from the rest. */
function splitEntry(entry: string): { rest: string[]; marker: string | null } {
  const segs = entry.split('|').map((x) => x.trim());
  const at = segs.findIndex((x) => MARKER.test(x));
  if (at < 0) return { rest: segs, marker: null };
  const marker = (MARKER.exec(segs[at]) as RegExpExecArray)[1].trim();
  return { rest: segs.filter((_, i) => i !== at), marker };
}

/**
 * Every list entry of a markdown body that carries a `valid-until:` segment. A marker that is neither a
 * calendar date nor `?` throws, naming the line: a typo must not quietly turn into a fact that never expires.
 */
export function parseExpiryMarkers(markdown: string): ExpiryMarker[] {
  const out: ExpiryMarker[] = [];
  markdown.split(/\r?\n/).forEach((raw, i) => {
    const m = LIST_LINE.exec(raw);
    if (!m) return;
    const { rest, marker } = splitEntry(m[2]);
    if (marker === null) return;
    if (marker !== '?' && !isCalendarDate(marker)) {
      throw new Error('line ' + (i + 1) + ': valid-until must be a real date as YYYY-MM-DD, or ? when it is not known (got "' + marker + '")');
    }
    const text = rest.filter((x) => x !== '' && !/^logo\s*:/i.test(x)).map(plain).join(' | ');
    if (!text) throw new Error('line ' + (i + 1) + ': a valid-until marker needs the entry it belongs to');
    out.push({ text, validUntil: marker === '?' ? null : marker, line: i + 1 });
  });
  return out;
}

/** The markdown with every valid-until segment removed from its list entry; nothing else is touched. */
export function stripExpiryMarkers(markdown: string): string {
  return markdown.split(/\r?\n/).map((raw) => {
    const m = LIST_LINE.exec(raw);
    if (!m) return raw;
    const { rest, marker } = splitEntry(m[2]);
    return marker === null ? raw : m[1] + rest.join(' | ');
  }).join('\n');
}

/** A path for a page: the home at /, everything else at /<slug>/ under its section. */
function pagePath(slug: string, isPost: boolean): string {
  if (!isPost && slug === 'index') return '/';
  return (isPost ? '/blog/' : '/') + slug + '/';
}

export interface ExpiryPageInput { slug: string; isPost: boolean; body: string }

/**
 * The facts the pages state, merged by their text: the same entry on two pages is ONE fact with two pages.
 * The same text with two different dates is refused, naming both pages.
 */
export function collectExpiryFacts(pages: ExpiryPageInput[]): ExpiryFact[] {
  const byLabel = new Map<string, ExpiryFact>();
  for (const p of [...pages].sort((a, b) => a.slug.localeCompare(b.slug))) {
    let markers: ExpiryMarker[];
    try { markers = parseExpiryMarkers(p.body); } catch (e) { throw new Error('page "' + p.slug + '": ' + (e as Error).message); }
    for (const mk of markers) {
      const path = pagePath(p.slug, p.isPost);
      const have = byLabel.get(mk.text);
      if (!have) {
        byLabel.set(mk.text, {
          id: 'fact-' + createHash('sha256').update(mk.text).digest('hex').slice(0, 12),
          label: mk.text, validUntil: mk.validUntil, pages: [{ slug: p.slug, path }],
        });
        continue;
      }
      if (have.validUntil !== mk.validUntil) {
        throw new Error('"' + mk.text + '" has two dates: ' + (have.validUntil ?? '?') + ' on ' + have.pages[0].path + ' and ' + (mk.validUntil ?? '?') + ' on ' + path + '. A fact has one date; fix one page.');
      }
      if (!have.pages.some((x) => x.slug === p.slug)) have.pages.push({ slug: p.slug, path });
    }
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The facts of a whole site's content map (keys `content/<file>.md`). Pages that are not published are left out unless includeDrafts. */
export function expiryFactsFromContent(files: Record<string, string>, opts: { includeDrafts?: boolean } = {}): ExpiryFact[] {
  const pages: ExpiryPageInput[] = [];
  for (const [file, text] of Object.entries(files)) {
    if (!file.endsWith('.md')) continue;
    const p = parsePageFile(text);
    if (p.status !== 'published' && !opts.includeDrafts) continue;
    pages.push({ slug: p.slug || file.replace(/^.*\//, '').replace(/\.md$/, ''), isPost: p.template === 'post', body: p.body });
  }
  return collectExpiryFacts(pages);
}

/** Every content file with its markers removed, ready for the importer and the renderer. Files without a marker are returned as they are. */
export function stripExpiryFromContent(files: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(files)) out[k] = k.endsWith('.md') ? stripExpiryMarkers(v) : v;
  return out;
}

function dayNumber(date: string): number {
  return Math.round(Date.parse(date + 'T00:00:00Z') / 86400000);
}

/** Sort facts into expired (date passed), warning (within the window), open (no date), ok. `today` is YYYY-MM-DD. */
export function classifyExpiry(facts: ExpiryFact[], today: string, windowDays = DEFAULT_WARNING_DAYS): ExpiryReport {
  if (!isCalendarDate(today)) throw new Error('today must be YYYY-MM-DD');
  const t = dayNumber(today);
  const r: ExpiryReport = { today, windowDays, expired: [], warning: [], open: [], ok: [] };
  for (const f of facts) {
    if (f.validUntil === null) { r.open.push(f); continue; }
    const left = dayNumber(f.validUntil) - t;
    if (left < 0) r.expired.push({ ...f, daysAgo: -left });
    else if (left <= windowDays) r.warning.push({ ...f, daysLeft: left });
    else r.ok.push(f);
  }
  return r;
}

/** The report as plain lines, each fact with every page that states it. */
export function describeExpiry(r: ExpiryReport): string[] {
  const where = (f: ExpiryFact): string => f.pages.map((p) => p.path).join(', ');
  const lines: string[] = [];
  for (const f of r.expired) lines.push('EXPIRED ' + f.validUntil + ' (' + f.daysAgo + ' day(s) ago): ' + f.label + ' | stated on ' + where(f));
  for (const f of r.warning) lines.push('EXPIRES SOON ' + f.validUntil + ' (' + f.daysLeft + ' day(s) left; window ' + r.windowDays + '): ' + f.label + ' | stated on ' + where(f));
  for (const f of r.open) lines.push('OPEN DATE: ' + f.label + ' | stated on ' + where(f));
  return lines;
}

/** The built site's facts file: only written when a page states at least one dated or open fact. */
export function factsFileText(facts: ExpiryFact[]): string {
  return JSON.stringify({ format: FACTS_FORMAT, facts: facts.map((f) => ({ id: f.id, label: f.label, validUntil: f.validUntil, pages: f.pages })) }, null, 2) + '\n';
}

export function parseFactsFile(text: string): ExpiryFact[] {
  const j = JSON.parse(text) as { format?: string; facts?: ExpiryFact[] };
  if (j.format !== FACTS_FORMAT || !Array.isArray(j.facts)) throw new Error('not a ' + FACTS_FORMAT + ' file');
  return j.facts;
}

/** Today in UTC as YYYY-MM-DD. */
export function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
