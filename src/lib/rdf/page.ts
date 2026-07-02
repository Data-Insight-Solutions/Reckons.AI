/**
 * Web-page model — the graph-authored website layer.
 *
 * A page is any entity typed `ktype:WebPage`. Its structural metadata lives under
 * the `page:` namespace (`urn:reckons:page/`); its position in the site tree reuses
 * the existing hierarchy vocabulary (`skos:broader` for parent, `nav:order` for
 * position, `nav:next`/`nav:prev` for sequence). Bodies are hybrid: a short
 * `page:excerpt` lives in the graph, while the long-form markdown body lives in the
 * exported `.md` file (optionally mirrored into `page:body` for a fully offline TTL).
 *
 * This module turns statements into an ordered `SitePage[]`; serialization to
 * markdown/frontmatter + zip/GitHub publishing lives in `src/lib/publish/site-export.ts`.
 */

import type { Statement } from './types';
import { SKOS_BROADER, SKOS_RELATED, NAV_ORDER, NAV_NEXT, NAV_PREV } from './hierarchy';

export const PAGE_NS       = 'urn:reckons:page/';
export const PAGE_SLUG     = `${PAGE_NS}slug`;
export const PAGE_SECTION  = `${PAGE_NS}section`;
export const PAGE_TEMPLATE = `${PAGE_NS}template`;
export const PAGE_STATUS   = `${PAGE_NS}status`;
export const PAGE_NAV      = `${PAGE_NS}nav`;
export const PAGE_EXCERPT  = `${PAGE_NS}excerpt`;
export const PAGE_BODY     = `${PAGE_NS}body`;

export const WEBPAGE_TYPE = 'urn:kbase:type/WebPage';

const RDF_TYPE   = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

export type PageTemplate = 'landing' | 'doc' | 'full' | 'sidebar';
export type PageStatus   = 'draft' | 'published' | 'unlisted';
export type PageNav       = 'menu' | 'sidebar' | 'both' | 'hidden';

export interface SitePage {
  iri: string;
  title: string;
  slug: string;
  section: string;          // top-level nav group; '' = ungrouped/root
  order: number;
  parent: string | null;    // parent page IRI (skos:broader)
  template: PageTemplate;
  status: PageStatus;
  nav: PageNav;
  excerpt: string;
  body: string;             // long-form markdown (from page:body if present, else '')
  related: string[];        // skos:related page IRIs
  next: string | null;
  prev: string | null;
}

const TEMPLATES = new Set<PageTemplate>(['landing', 'doc', 'full', 'sidebar']);
const STATUSES  = new Set<PageStatus>(['draft', 'published', 'unlisted']);
const NAVS      = new Set<PageNav>(['menu', 'sidebar', 'both', 'hidden']);

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/** Derive a URL-safe slug from a title. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'page';
}

/**
 * Build the ordered list of site pages from statements.
 * Sorted by (section, order, title) so callers get a deterministic site structure.
 */
export function buildSitePages(stmts: Statement[]): SitePage[] {
  const active = stmts.filter(isActive);

  // Identify WebPage subjects
  const pageIris = new Set<string>();
  for (const s of active) {
    if (s.p.value === RDF_TYPE && s.s.kind === 'iri' && s.o.kind === 'iri' && s.o.value === WEBPAGE_TYPE) {
      pageIris.add(s.s.value);
    }
  }

  // First pass: single-valued fields
  const title    = new Map<string, string>();
  const slug     = new Map<string, string>();
  const section  = new Map<string, string>();
  const order    = new Map<string, number>();
  const parent   = new Map<string, string>();
  const template = new Map<string, PageTemplate>();
  const status   = new Map<string, PageStatus>();
  const nav       = new Map<string, PageNav>();
  const excerpt  = new Map<string, string>();
  const body     = new Map<string, string>();
  const next     = new Map<string, string>();
  const prev     = new Map<string, string>();
  const related  = new Map<string, string[]>();

  for (const s of active) {
    if (s.s.kind !== 'iri' || !pageIris.has(s.s.value)) continue;
    const iri = s.s.value;
    const p = s.p.value;

    if (p === RDFS_LABEL && s.o.kind === 'literal') title.set(iri, s.o.value);
    else if (p === PAGE_SLUG && s.o.kind === 'literal') slug.set(iri, s.o.value);
    else if (p === PAGE_SECTION && s.o.kind === 'literal') section.set(iri, s.o.value);
    else if (p === NAV_ORDER && s.o.kind === 'literal') order.set(iri, parseInt(s.o.value, 10));
    else if (p === SKOS_BROADER && s.o.kind === 'iri') parent.set(iri, s.o.value);
    else if (p === PAGE_TEMPLATE && s.o.kind === 'literal' && TEMPLATES.has(s.o.value as PageTemplate)) template.set(iri, s.o.value as PageTemplate);
    else if (p === PAGE_STATUS && s.o.kind === 'literal' && STATUSES.has(s.o.value as PageStatus)) status.set(iri, s.o.value as PageStatus);
    else if (p === PAGE_NAV && s.o.kind === 'literal' && NAVS.has(s.o.value as PageNav)) nav.set(iri, s.o.value as PageNav);
    else if (p === PAGE_EXCERPT && s.o.kind === 'literal') excerpt.set(iri, s.o.value);
    else if (p === PAGE_BODY && s.o.kind === 'literal') body.set(iri, s.o.value);
    else if (p === NAV_NEXT && s.o.kind === 'iri') next.set(iri, s.o.value);
    else if (p === NAV_PREV && s.o.kind === 'iri') prev.set(iri, s.o.value);
    else if (p === SKOS_RELATED && s.o.kind === 'iri') {
      const arr = related.get(iri) ?? [];
      arr.push(s.o.value);
      related.set(iri, arr);
    }
  }

  const pages: SitePage[] = [...pageIris].map((iri) => {
    const t = title.get(iri) ?? iri.split('/').pop() ?? iri;
    return {
      iri,
      title: t,
      slug: slug.get(iri) ?? slugify(t),
      section: section.get(iri) ?? '',
      order: order.get(iri) ?? 0,
      parent: parent.get(iri) ?? null,
      template: template.get(iri) ?? 'doc',
      status: status.get(iri) ?? 'draft',
      nav: nav.get(iri) ?? 'sidebar',
      excerpt: excerpt.get(iri) ?? '',
      body: body.get(iri) ?? '',
      related: (related.get(iri) ?? []).sort(),
      next: next.get(iri) ?? null,
      prev: prev.get(iri) ?? null,
    };
  });

  pages.sort((a, b) => {
    if (a.section !== b.section) return a.section.localeCompare(b.section);
    if (a.order !== b.order) return a.order - b.order;
    return a.title.localeCompare(b.title);
  });

  return pages;
}

/** Pages that are safe to publish publicly (published or unlisted, not drafts). */
export function publishablePages(pages: SitePage[]): SitePage[] {
  return pages.filter((p) => p.status === 'published' || p.status === 'unlisted');
}
