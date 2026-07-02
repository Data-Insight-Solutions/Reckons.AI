/**
 * Site import — the inverse of `site-export.ts`: turn a published content file
 * (frontmatter + markdown body) back into `ktype:WebPage` graph statements.
 *
 * Graph-first publishing (see plan "Sveltia CMS Publishing"): the graph is the
 * source of truth, but Sveltia CMS (and hand-edits) land on `content/<section>/
 * <slug>.md`. This module round-trips those files back into the graph so edits
 * made in the CMS — or drift checked by `scripts/md-align.ts` — can be
 * reconciled with the WebPage entities in `src/lib/rdf/page.ts`.
 *
 * `parsePageFile` reads one file's frontmatter + body. `importSitePages` (and
 * the `importSiteFiles` convenience wrapper) turn a *batch* of parsed files
 * into statements, because a few fields only make sense across the whole site:
 *
 *   - `parent` (frontmatter slug) → `skos:broader`, resolved against the other
 *     slugs in the batch.
 *   - `related` (frontmatter slugs) → `skos:related`, same resolution.
 *   - `nav:next` / `nav:prev` — `pageToMarkdown` never writes these to
 *     frontmatter (order + section already encode the sequence), so import
 *     reconstructs the sibling chain deterministically: pages are grouped by
 *     (section, parent) and sorted by (order, slug), then linked next/prev.
 *
 * Export → import → export is idempotent for the markdown text itself: every
 * field `pageToMarkdown` writes is parsed back out and re-emitted unchanged
 * (see `src/lib/publish/__tests__/site-import.test.ts`). `scripts/md-align.ts`
 * uses exactly this to flag `content/*.md` files that drifted from the graph.
 */

import type { PageNav, PageStatus, PageTemplate } from '../rdf/page';
import type { ReviewStatus, Statement, Term } from '../rdf/types';
import { iri, lit } from '../rdf/types';
import {
  PAGE_SLUG, PAGE_SECTION, PAGE_TEMPLATE, PAGE_STATUS, PAGE_NAV, PAGE_EXCERPT, PAGE_BODY,
  WEBPAGE_TYPE, slugify,
} from '../rdf/page';
import { SKOS_BROADER, SKOS_RELATED, NAV_ORDER, NAV_NEXT, NAV_PREV } from '../rdf/hierarchy';

const RDF_TYPE   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const TEMPLATES: readonly PageTemplate[] = ['landing', 'doc', 'full', 'sidebar'];
const STATUSES: readonly PageStatus[] = ['draft', 'published', 'unlisted'];
const NAVS: readonly PageNav[] = ['menu', 'sidebar', 'both', 'hidden'];

// ── Frontmatter parsing ──────────────────────────────────────────────────────

export interface ParsedPageFile {
  title: string;
  slug: string;
  order: number;
  section: string;           // '' = ungrouped/root, mirrors SitePage.section
  parentSlug: string | null; // frontmatter `parent` — resolved to an IRI at import time
  template: PageTemplate;
  status: PageStatus;
  nav: PageNav;
  excerpt: string;
  relatedSlugs: string[];    // frontmatter `related` — resolved to IRIs at import time
  body: string;
}

interface RawFrontmatter {
  title?: string;
  slug?: string;
  order?: number;
  section?: string;
  parent?: string;
  template?: string;
  status?: string;
  nav?: string;
  excerpt?: string;
  related?: string[];
}

/** Reverse `yamlStr()` from site-export.ts — that's JSON string escaping (backslash, quote). */
function unquoteYaml(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      /* fall through to raw */
    }
  }
  return t;
}

function parseFrontmatterBlock(header: string): RawFrontmatter {
  const fm: RawFrontmatter = {};
  let inRelated = false;

  for (const line of header.split(/\r?\n/)) {
    const listItem = /^ {2}-\s*(.*)$/.exec(line);
    if (inRelated && listItem) {
      (fm.related ??= []).push(unquoteYaml(listItem[1]));
      continue;
    }
    inRelated = false;

    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, rawVal] = kv;

    if (key === 'related' && rawVal.trim() === '') {
      inRelated = true;
      fm.related = fm.related ?? [];
      continue;
    }

    switch (key) {
      case 'title': fm.title = unquoteYaml(rawVal); break;
      case 'slug': fm.slug = unquoteYaml(rawVal); break;
      case 'section': fm.section = unquoteYaml(rawVal); break;
      case 'parent': fm.parent = unquoteYaml(rawVal); break;
      case 'excerpt': fm.excerpt = unquoteYaml(rawVal); break;
      case 'order': {
        const n = parseInt(rawVal.trim(), 10);
        if (!Number.isNaN(n)) fm.order = n;
        break;
      }
      case 'template': fm.template = rawVal.trim(); break;
      case 'status': fm.status = rawVal.trim(); break;
      case 'nav': fm.nav = rawVal.trim(); break;
      default: break; // unknown key — ignore (forward-compatible with hand-edits)
    }
  }

  return fm;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Parse one `content/<section>/<slug>.md` source string into its page fields.
 * `body` is the exact remainder after the closing `---` (minus the single
 * blank separator line `pageToMarkdown` always writes) — this preserves the
 * body byte-for-byte so re-export round-trips cleanly.
 */
export function parsePageFile(source: string): ParsedPageFile {
  const m = FRONTMATTER_RE.exec(source);
  if (!m) {
    // No frontmatter — treat the whole file as an untitled body.
    return {
      title: '', slug: '', order: 0, section: '', parentSlug: null,
      template: 'doc', status: 'draft', nav: 'sidebar', excerpt: '',
      relatedSlugs: [], body: source,
    };
  }

  const [, header, rest] = m;
  const body = rest.replace(/^\r?\n/, '');
  const fm = parseFrontmatterBlock(header);

  const title = fm.title ?? '';
  return {
    title,
    slug: fm.slug ?? slugify(title),
    order: fm.order ?? 0,
    section: fm.section ?? '',
    parentSlug: fm.parent ?? null,
    template: fm.template && (TEMPLATES as string[]).includes(fm.template) ? (fm.template as PageTemplate) : 'doc',
    status: fm.status && (STATUSES as string[]).includes(fm.status) ? (fm.status as PageStatus) : 'draft',
    nav: fm.nav && (NAVS as string[]).includes(fm.nav) ? (fm.nav as PageNav) : 'sidebar',
    excerpt: fm.excerpt ?? '',
    relatedSlugs: fm.related ?? [],
    body,
  };
}

// ── Parsed files → WebPage statements ────────────────────────────────────────

export interface SiteImportOptions {
  /** Build an entity IRI for a page's slug. Default: `urn:kbase:concept/<slug>` (the
   *  standard entity namespace used elsewhere in the app — see rdf/semantic-diff.ts). */
  entityIri?: (slug: string) => string;
  /** Provenance source id stamped on produced statements (default `'site-import'`). */
  sourceId?: string;
  /** Review status stamped on produced statements — these reconstruct entities that
   *  already existed in the graph, so default to `'confirmed'`, not `'pending'`. */
  status?: ReviewStatus;
  /** Fixed timestamp for created/updated — mainly for deterministic tests. */
  now?: number;
}

/**
 * Convert a batch of parsed content files into WebPage-entity statements.
 * Cross-file fields (parent, related, next/prev) are resolved against the
 * other slugs in the same batch — pass the whole site (or at least a section)
 * in one call, not one file at a time, or those links will be dropped.
 */
export function importSitePages(files: ParsedPageFile[], opts: SiteImportOptions = {}): Statement[] {
  const entityIri = opts.entityIri ?? ((slug: string) => `urn:kbase:concept/${slug}`);
  const sourceId = opts.sourceId ?? 'site-import';
  const status: ReviewStatus = opts.status ?? 'confirmed';
  const now = opts.now ?? Date.now();
  const g = iri(`urn:kbase:source/${sourceId}`);

  const slugToIri = new Map<string, string>();
  for (const f of files) slugToIri.set(f.slug, entityIri(f.slug));

  // Reconstruct nav:next/prev: group siblings by (section, parent), order by
  // (order, slug) — the same tie-break buildSitePages effectively applies via
  // its (section, order, title) sort — and chain them.
  const groups = new Map<string, ParsedPageFile[]>();
  for (const f of files) {
    const key = `${f.section} ${f.parentSlug ?? ''}`;
    const arr = groups.get(key);
    if (arr) arr.push(f);
    else groups.set(key, [f]);
  }
  const nextOf = new Map<string, string>();
  const prevOf = new Map<string, string>();
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
    for (let i = 0; i < sorted.length - 1; i++) {
      nextOf.set(sorted[i].slug, sorted[i + 1].slug);
      prevOf.set(sorted[i + 1].slug, sorted[i].slug);
    }
  }

  let n = 0;
  const mk = (s: string, p: string, o: Term): Statement => ({
    id: `${sourceId}-${++n}`,
    s: iri(s),
    p: iri(p),
    o,
    g,
    sourceId,
    confidence: 1,
    status,
    createdAt: now,
    updatedAt: now,
  });

  const stmts: Statement[] = [];
  for (const f of files) {
    const subject = slugToIri.get(f.slug)!;
    stmts.push(mk(subject, RDF_TYPE, iri(WEBPAGE_TYPE)));
    if (f.title) stmts.push(mk(subject, RDFS_LABEL, lit(f.title)));
    stmts.push(mk(subject, PAGE_SLUG, lit(f.slug)));
    if (f.section) stmts.push(mk(subject, PAGE_SECTION, lit(f.section)));
    stmts.push(mk(subject, NAV_ORDER, lit(String(f.order))));
    if (f.parentSlug && slugToIri.has(f.parentSlug)) {
      stmts.push(mk(subject, SKOS_BROADER, iri(slugToIri.get(f.parentSlug)!)));
    }
    stmts.push(mk(subject, PAGE_TEMPLATE, lit(f.template)));
    stmts.push(mk(subject, PAGE_STATUS, lit(f.status)));
    stmts.push(mk(subject, PAGE_NAV, lit(f.nav)));
    if (f.excerpt) stmts.push(mk(subject, PAGE_EXCERPT, lit(f.excerpt)));
    if (f.body) stmts.push(mk(subject, PAGE_BODY, lit(f.body)));
    for (const relSlug of f.relatedSlugs) {
      if (slugToIri.has(relSlug)) stmts.push(mk(subject, SKOS_RELATED, iri(slugToIri.get(relSlug)!)));
    }
    const nxt = nextOf.get(f.slug);
    if (nxt) stmts.push(mk(subject, NAV_NEXT, iri(slugToIri.get(nxt)!)));
    const prv = prevOf.get(f.slug);
    if (prv) stmts.push(mk(subject, NAV_PREV, iri(slugToIri.get(prv)!)));
  }

  return stmts;
}

/**
 * Parse + import a repo-relative file map (as produced by checking out
 * `content/**\/*.md`, or by `buildSiteFiles`'s own output). Non-content-markdown
 * entries (`graph.json`, `admin/*`) are ignored so callers can pass either a
 * filtered file list or the full site export file-set.
 */
export function importSiteFiles(files: Record<string, string>, opts: SiteImportOptions = {}): Statement[] {
  const pages = Object.entries(files)
    .filter(([path]) => path.startsWith('content/') && path.endsWith('.md'))
    .map(([, source]) => parsePageFile(source));
  return importSitePages(pages, opts);
}
