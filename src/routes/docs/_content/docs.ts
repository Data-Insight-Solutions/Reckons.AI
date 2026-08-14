/**
 * Docs content loader — F27 Graph Publishing, Phase 2.
 *
 * The graph is the source of truth; `src/lib/publish/site-export.ts` serializes
 * `ktype:WebPage` nodes to `content/<section>/<slug>.md` (YAML frontmatter + a
 * markdown body — see `pageToMarkdown`). This module is the read side: it globs
 * those files at build time (mdsvex compiles `.md` into Svelte components per
 * `svelte.config.js`), exposes their frontmatter for navigation, and resolves a
 * single page by its `[...slug]` route param.
 *
 * Leading underscore keeps this directory out of SvelteKit's route tree.
 */

import type { Component } from 'svelte';

/** Mirrors the frontmatter shape written by `pageToMarkdown` in site-export.ts. */
export interface DocFrontmatter {
  title: string;
  slug: string;
  order: number;
  section?: string;
  parent?: string;
  template?: 'landing' | 'doc' | 'full' | 'sidebar' | 'post';
  status?: 'draft' | 'published' | 'unlisted';
  nav?: 'menu' | 'sidebar' | 'both' | 'hidden';
  excerpt?: string;
  related?: string[];
  /** ISO yyyy-mm-dd — posts only (`template: 'post'`). */
  date?: string;
}

export interface DocEntry {
  /** Route param for /docs/[...slug] — the content-relative path, e.g. "docs/welcome". */
  path: string;
  metadata: DocFrontmatter;
  component: Component;
}

type MdModule = { metadata: DocFrontmatter; default: Component };

// Path starting with "/" is resolved relative to the project root by Vite, so this
// reaches content/ at the repo root even though this file lives under src/routes.
const modules = import.meta.glob<MdModule>('/content/**/*.md', { eager: true });

function pathToSlug(globPath: string): string {
  return globPath.replace(/^\/content\//, '').replace(/\.md$/, '');
}

/** All non-draft docs, sorted by (section, order, title) — mirrors buildSitePages(). */
export function allDocs(): DocEntry[] {
  const docs: DocEntry[] = Object.entries(modules)
    .filter(([, mod]) => mod.metadata?.status !== 'draft')
    .map(([globPath, mod]) => ({
      path: pathToSlug(globPath),
      metadata: mod.metadata,
      component: mod.default,
    }));

  docs.sort((a, b) => {
    const sa = a.metadata.section ?? '';
    const sb = b.metadata.section ?? '';
    if (sa !== sb) return sa.localeCompare(sb);
    const oa = a.metadata.order ?? 0;
    const ob = b.metadata.order ?? 0;
    if (oa !== ob) return oa - ob;
    return a.metadata.title.localeCompare(b.metadata.title);
  });

  return docs;
}

export interface DocSection {
  section: string;
  docs: DocEntry[];
}

/** Reverse-chronological comparator for posts — mirrors `sitePosts()` in rdf/page.ts:
 *  newest date first, undated posts sort last, ties broken by title. */
function comparePostsDesc(a: DocEntry, b: DocEntry): number {
  const da = a.metadata.date ?? '';
  const db = b.metadata.date ?? '';
  if (da !== db) {
    if (!da) return 1;
    if (!db) return -1;
    return db.localeCompare(da);
  }
  return a.metadata.title.localeCompare(b.metadata.title);
}

/**
 * Docs grouped by section — feeds the docs nav.
 *
 * SECTION ORDER COMES FROM THE CONTENT, NOT THE ALPHABET. `allDocs()` sorts by section NAME
 * first, so relying on first-seen order put "Build" above "Learn" no matter what `order` said —
 * the site silently ignored the running order its own frontmatter declared. A section now takes
 * the position of its EARLIEST page, so a site that orders its pages orders its nav for free,
 * with the section name only breaking ties (keeping the result deterministic).
 *
 * A section made up entirely of posts (`template: 'post'`, e.g. release notes) is re-sorted
 * newest-first by date; mixed/non-post sections keep the (order, title) sort from `allDocs()`.
 */
export function docsBySection(): DocSection[] {
  const sections: DocSection[] = [];
  const bySection = new Map<string, DocEntry[]>();
  for (const doc of allDocs()) {
    const key = doc.metadata.section?.trim() || 'Docs';
    let list = bySection.get(key);
    if (!list) {
      list = [];
      bySection.set(key, list);
      sections.push({ section: key, docs: list });
    }
    list.push(doc);
  }
  for (const s of sections) {
    if (s.docs.length && s.docs.every((d) => d.metadata.template === 'post')) {
      s.docs.sort(comparePostsDesc);
    }
  }

  // Position a section by its earliest page. Computed AFTER the post re-sort above so a
  // release-notes section is placed by the page that actually renders first in it.
  const rank = (s: DocSection): number =>
    s.docs.reduce((lowest, d) => Math.min(lowest, d.metadata.order ?? 0), Number.POSITIVE_INFINITY);
  sections.sort((a, b) => (rank(a) - rank(b)) || a.section.localeCompare(b.section));

  return sections;
}

/** Resolve a single doc by its /docs/[...slug] route param. */
export function findDoc(slug: string): DocEntry | undefined {
  return allDocs().find((d) => d.path === slug);
}

/** All slugs — used by +page.ts entries() to tell adapter-static what to prerender. */
export function allSlugs(): string[] {
  return allDocs().map((d) => d.path);
}
