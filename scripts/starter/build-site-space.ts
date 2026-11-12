#!/usr/bin/env npx tsx
/**
 * Builds static/starter-data-insight-solutions.ttl: a real website's PUBLISHED content as an example space
 * (F274.7, kb:downstream-site-space). The site's own content/ goes through the importer the site build runs
 * (importSiteWithBlog), and each published page and post becomes an entity with its title, section, date,
 * categories, excerpt and public URL, linked to its neighbours; the site is one entity published by an
 * organization, with a leap to the website's address.
 *
 *   npx tsx scripts/starter/build-site-space.ts --site=<site repository> [--url=<public address>] [--check]
 *
 * It also carries, generated from the same build: a story 'How this website was made' (F292.1, scripts/starter/site-story.ts),
 * the one footer line shown on every page (read from footer.text of site.config.json, public by design), an expiry-check node,
 * and any list entry a page marks `| valid-until: <date or ?>` (F293) as a fact stated on the pages that say it.
 *
 * ONLY published pages are ever included. Drafts, the pages' bodies, workspace/ files, the site config and the
 * contact webhook are never read into the space (the config is read for its public address only, never the
 * webhook). `--check` fails when the committed file differs from what the site repository now generates, and is
 * report-only when the site repository is absent on this machine, so CI does not need it.
 * Written in the app's annotated export (toTurtleFull) with no generated-at line, so two runs are identical.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { importSiteWithBlog } from '../../src/lib/publish/site-blog.js';
import { readSiteContent } from '../../src/lib/publish/site-build.js';
import { toTurtleFull } from '../../src/lib/rdf/serialize.js';
import { iri, lit, type Source, type Statement, type Term } from '../../src/lib/rdf/types.js';
import { STATED_ON_PREDICATE, VALID_UNTIL_PREDICATE, expiryFactsFromContent } from '../../src/lib/publish/site-expiry.js';
import { XSD_INT, storyTriples, type StoryFact } from './site-story.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = path.join(ROOT, 'static', 'starter-data-insight-solutions.ttl');

const KB = 'urn:kbase:concept/';
const TYPE = 'urn:kbase:type/';
const KP = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
const PAGE = 'urn:reckons:page/';
const NAV = 'urn:reckons:nav/';
const LEAP = 'urn:reckons:leap';
const LEAP_LABEL = 'urn:reckons:leap/label';
const AT = Date.parse('2026-11-11T09:00:00Z');
const SOURCE_ID = 'dis-website';

export type SpaceOptions = { url: string; publisher?: string; siteName?: string; footer?: string };
export type SpaceResult = { text: string; pages: number; posts: number; skippedNotPublished: number; statements: Statement[] };

/** The site's address with no trailing slash; refuses anything that is not an https URL with no credentials. */
export function normalizeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error('the site address is not a URL'); }
  if (u.protocol !== 'https:' || u.username || u.password) throw new Error('the site address must be an https URL with no credentials');
  return u.origin;
}

/** The public URL of a page: the home at /, a post under /blog/, every other page at /<slug>/. */
function publicUrl(base: string, slug: string, isPost: boolean, isHome: boolean): string {
  if (isHome) return base + '/';
  return base + (isPost ? '/blog/' : '/') + slug + '/';
}

export function buildSiteSpace(files: Record<string, string>, opts: SpaceOptions): SpaceResult {
  const base = normalizeUrl(opts.url);
  const siteName = opts.siteName ?? 'Data Insight Solutions';
  const publisher = opts.publisher ?? 'Data Insight Solutions LLC';
  const imported = importSiteWithBlog(files);
  const bySubject = new Map<string, Map<string, string[]>>();
  for (const s of imported) {
    if (s.o.kind === 'iri' && s.p.value !== RDF_TYPE && !s.p.value.startsWith(NAV)) continue;
    let m = bySubject.get(s.s.value);
    if (!m) bySubject.set(s.s.value, (m = new Map()));
    const a = m.get(s.p.value) ?? [];
    a.push(s.o.value);
    m.set(s.p.value, a);
  }
  const val = (m: Map<string, string[]>, p: string): string | undefined => m.get(p)?.[0];

  const out: Statement[] = [];
  const add = (s: string, p: string, o: Term, extra: Partial<Statement> = {}): void => {
    const key = `${s}|${p}|${o.kind}:${o.value}`;
    out.push({
      id: 'dis-' + createHash('sha256').update(key).digest('hex').slice(0, 16),
      s: iri(s), p: iri(p), o, g: iri('urn:kbase:source/' + SOURCE_ID), sourceId: SOURCE_ID,
      confidence: 1, status: 'confirmed', createdAt: AT, updatedAt: AT, ...extra,
    });
  };

  const siteIri = KB + 'dis-site';
  const orgIri = KB + 'dis-llc';
  const blogIri = KB + 'dis-blog';
  add(siteIri, RDF_TYPE, iri(TYPE + 'Website'));
  add(siteIri, RDFS_LABEL, lit(siteName));
  add(siteIri, RDFS_COMMENT, lit('A real website, published by ' + publisher + ' and shown here as a space: each published page and post is a node, linked to its neighbours.'));
  add(siteIri, KP + 'url', lit(base + '/'));
  add(siteIri, KP + 'published-by', iri(orgIri));
  add(siteIri, LEAP, lit(base + '/'));
  add(siteIri, LEAP_LABEL, lit('Open the website'));
  add(orgIri, RDF_TYPE, iri(TYPE + 'Organization'));
  add(orgIri, RDFS_LABEL, lit(publisher));

  let pages = 0, posts = 0, skipped = 0, hasPosts = false;
  const published = new Set<string>();
  const nodeBySlug = new Map<string, string>();
  const pageNodes: string[] = [];
  for (const [subject, m] of [...bySubject].sort(([a], [b]) => a.localeCompare(b))) {
    if (val(m, RDF_TYPE) !== TYPE + 'WebPage') continue;
    if (val(m, PAGE + 'status') !== 'published') { skipped++; continue; }
    published.add(subject);
  }
  for (const subject of [...published].sort()) {
    const m = bySubject.get(subject)!;
    const slug = val(m, PAGE + 'slug') ?? subject.slice(KB.length);
    const isPost = val(m, PAGE + 'template') === 'post';
    const isHome = !isPost && slug === 'index';
    const node = KB + 'dis-' + (isPost ? 'post-' : 'page-') + slug.replace(/[^A-Za-z0-9_-]/g, '-');
    nodeBySlug.set(slug, node);
    if (!isPost) pageNodes.push(node);
    add(node, RDF_TYPE, iri(TYPE + (isPost ? 'BlogPost' : 'WebPage')));
    add(node, RDFS_LABEL, lit(val(m, RDFS_LABEL) ?? slug));
    const excerpt = val(m, PAGE + 'excerpt');
    if (excerpt) add(node, RDFS_COMMENT, lit(excerpt));
    add(node, KP + 'url', lit(publicUrl(base, slug, isPost, isHome)));
    const section = val(m, PAGE + 'section');
    if (section) add(node, KP + 'section', lit(section));
    const date = val(m, PAGE + 'date');
    if (date) add(node, KP + 'date', lit(date));
    for (const c of m.get(PAGE + 'category') ?? []) add(node, KP + 'category', lit(c));
    add(node, KP + 'part-of', iri(isPost ? blogIri : siteIri));
    for (const rel of ['next', 'prev'] as const) {
      const target = val(m, NAV + rel);
      if (target && published.has(target)) {
        const t = bySubject.get(target)!;
        const tSlug = val(t, PAGE + 'slug') ?? target.slice(KB.length);
        const tPost = val(t, PAGE + 'template') === 'post';
        add(node, NAV + rel, iri(KB + 'dis-' + (tPost ? 'post-' : 'page-') + tSlug.replace(/[^A-Za-z0-9_-]/g, '-')));
      }
    }
    if (isPost) { posts++; hasPosts = true; } else pages++;
  }
  if (hasPosts) {
    add(blogIri, RDF_TYPE, iri(TYPE + 'Section'));
    add(blogIri, RDFS_LABEL, lit('Blog'));
    add(blogIri, KP + 'url', lit(base + '/blog/'));
    add(blogIri, KP + 'part-of', iri(siteIri));
  }

  // F293: facts a page marks with a valid-until date, and F292.1: the story of how the site was made.
  const checkIri = KB + 'dis-expiry-check';
  add(checkIri, RDF_TYPE, iri(TYPE + 'Check'));
  add(checkIri, RDFS_LABEL, lit('Expiry check'));
  add(checkIri, RDFS_COMMENT, lit('Runs on every build and in the script tier (scripts/offline/fact-expiry.ts): lists any fact past its valid-until date, warns 60 days ahead, and the build refuses to publish a page that states an expired fact.'));
  add(checkIri, KP + 'part-of', iri(siteIri));
  const storyFacts: StoryFact[] = [];
  for (const f of expiryFactsFromContent(files)) {
    const factIri = KB + 'dis-' + f.id;
    const statedOn = f.pages.map((pg) => nodeBySlug.get(pg.slug)).filter((x): x is string => !!x);
    add(factIri, RDF_TYPE, iri(TYPE + 'Fact'));
    add(factIri, RDFS_LABEL, lit(f.label));
    if (f.validUntil) add(factIri, VALID_UNTIL_PREDICATE, lit(f.validUntil, 'http://www.w3.org/2001/XMLSchema#date'));
    else add(factIri, VALID_UNTIL_PREDICATE, lit('?'), { status: 'pending', needsObject: true, askedBy: 'site-build', blocks: statedOn, question: 'On what date does "' + f.label + '" stop being true?' });
    for (const pn of statedOn) add(factIri, STATED_ON_PREDICATE, iri(pn));
    storyFacts.push({ iri: factIri, label: f.label, validUntil: f.validUntil, pageCount: statedOn.length });
  }
  const sharedIri = KB + 'dis-shared-footer';
  const sharedText = opts.footer ?? siteName;
  add(sharedIri, RDF_TYPE, iri(TYPE + 'Fact'));
  add(sharedIri, RDFS_LABEL, lit(sharedText));
  add(sharedIri, RDFS_COMMENT, lit('Written once in the site settings; every page and post shows it.'));
  for (const pn of nodeBySlug.values()) add(sharedIri, STATED_ON_PREDICATE, iri(pn));
  const storyIri = KB + 'dis-story';
  for (const t of storyTriples({
    storyIri, stepIri: (k) => KB + 'dis-story-step-' + k, siteName, siteIri, blogIri: hasPosts ? blogIri : null, checkIri,
    pageNodes, pages, posts, shared: { iri: sharedIri, text: sharedText, pageCount: nodeBySlug.size }, expiring: storyFacts,
  })) {
    add(t.s, t.p, 'iri' in t.o ? iri(t.o.iri) : 'integer' in t.o ? lit(String(t.o.integer), XSD_INT) : lit(t.o.text));
  }

  const source: Source = { id: SOURCE_ID, title: siteName + ' website', uri: base + '/', ingestedAt: AT, kind: 'url', trustLevel: 'trusted' };
  const header = [
    `${siteName}: the website's published pages and posts as a space (F274.7, kb:downstream-site-space).`,
    'Generated by scripts/starter/build-site-space.ts from the site repository; do not edit by hand.',
    'Only published pages and posts are included: no drafts, no page bodies (only the text of an entry a page marks valid-until), no site config beyond the public footer line, no contact address.',
  ].join('\n');
  const text = toTurtleFull(out, [source], { header }).replace(/^# generated .*\n/m, '');
  return { text, pages, posts, skippedNotPublished: skipped, statements: out };
}

/** The footer line the site shows on every page: the `footer.text` field of site.config.json (public by design), never any other field. */
export function resolveFooter(site: string): string | undefined {
  const cfg = path.join(site, 'site.config.json');
  if (!existsSync(cfg)) return undefined;
  try {
    const f = (JSON.parse(readFileSync(cfg, 'utf8')) as { footer?: { text?: unknown } }).footer?.text;
    return typeof f === 'string' && f.trim() ? f.trim() : undefined;
  } catch { return undefined; }
}

/** The public address: --url, else a `url` or `siteUrl` field of site.config.json (never any other field). */
export function resolveUrl(site: string, flagUrl?: string): string {
  if (flagUrl) return flagUrl;
  const cfg = path.join(site, 'site.config.json');
  if (existsSync(cfg)) {
    try {
      const j = JSON.parse(readFileSync(cfg, 'utf8')) as Record<string, unknown>;
      for (const k of ['siteUrl', 'url']) if (typeof j[k] === 'string' && j[k]) return j[k] as string;
    } catch { /* fall through to the refusal below */ }
  }
  throw new Error('no public address: pass --url=https://... (site.config.json has no url or siteUrl field)');
}

function main(): void {
  const arg = (n: string): string | undefined => process.argv.find((a) => a.startsWith('--' + n + '='))?.split('=').slice(1).join('=');
  const check = process.argv.includes('--check');
  const site = arg('site');
  if (!site || !existsSync(path.join(path.resolve(site), 'content'))) {
    if (check) { console.log('build-site-space --check: the site repository is not on this machine; nothing to compare (report-only)'); return; }
    console.error('Usage: npx tsx scripts/starter/build-site-space.ts --site=<site repository> [--url=<https address>] [--check]');
    process.exit(1);
  }
  const r = buildSiteSpace(readSiteContent(path.resolve(site)), { url: resolveUrl(path.resolve(site), arg('url')), footer: resolveFooter(path.resolve(site)) });
  if (check) {
    const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (cur !== r.text) { console.error('build-site-space --check: static/starter-data-insight-solutions.ttl is stale. Run: npx tsx scripts/starter/build-site-space.ts --site=<site repository> --url=<address>'); process.exit(1); }
    console.log('build-site-space --check: up to date');
    return;
  }
  writeFileSync(OUT, r.text);
  console.log(`wrote static/starter-data-insight-solutions.ttl: ${r.pages} page(s), ${r.posts} post(s); ${r.skippedNotPublished} not published and left out`);
}

if (process.argv[1] && process.argv[1].endsWith('build-site-space.ts')) main();
