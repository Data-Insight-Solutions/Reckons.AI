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
  template?: 'landing' | 'doc' | 'full' | 'sidebar';
  status?: 'draft' | 'published' | 'unlisted';
  nav?: 'menu' | 'sidebar' | 'both' | 'hidden';
  excerpt?: string;
  related?: string[];
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

/** Docs grouped by section, in first-seen (already sorted) order — feeds the docs nav. */
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
