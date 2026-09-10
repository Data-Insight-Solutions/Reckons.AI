#!/usr/bin/env npx tsx
/**
 * Build the docs search index (F191) — one document per PUBLISHED PAGE.
 *
 * WHY PAGES AND NOT THE GRAPH, for now. kb:docs-search argues for indexing the graph, because
 * mcp-server/src/search.ts already runs BM25 over triples and kb:node-synonyms would let a query
 * for "deployment" also reach "promotion". Both true, and neither helps yet: skos:altLabel is
 * asserted ZERO times across the graphs (measured 2026-09-08), so the synonym advantage is
 * currently worth nothing — and an entity that FOLDS has no page, so a graph-keyed hit would have
 * nowhere to send the reader.
 *
 * Indexing the published pages gets both right by construction: every hit has a URL, and a folded
 * child's text is searchable because it is part of its parent's page, which is exactly where a
 * reader will find it. When altLabels exist, enrich these documents with them rather than building
 * a second index — the unit stays the page.
 *
 * Usage: npx tsx scripts/docs-search-index.ts [--check]
 */
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve, relative } from 'path';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const CONTENT = join(ROOT, 'content');
const OUT = join(ROOT, 'static', 'docs-search-index.json');
const CHECK = process.argv.includes('--check');

export interface SearchDoc {
  path: string;      // route param for /docs/[...slug]
  title: string;
  section: string;
  excerpt: string;
  /** Headings inside the page — a folded child's title lives here and must be findable. */
  headings: string[];
  /** Body prose, stripped of markup and of the rendered SVG/image markup around it. */
  text: string;
}

/**
 * Walk content/ for markdown, without following symbolic links.
 *
 * The first version used statSync, which FOLLOWS a link, so a symlinked directory pointing at an
 * ancestor would recurse until the stack gave out. Nothing in content/ is a link today, but this
 * repository symlinks graphs into MCP workspaces as a matter of course, and a build that hangs is
 * a bad way to find out someone did it here. Dirent.isDirectory() reports a link as a link, so
 * this cannot cycle — the same approach walkMd() in docs-pages.ts already takes.
 */
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

export function buildIndex(): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const file of walk(CONTENT).sort()) {
    const raw = readFileSync(file, 'utf8');
    const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
    if (!m) continue;
    const fm = Object.fromEntries(
      [...m[1].matchAll(/^(\w+):\s*(.*)$/gm)].map(([, k, v]) => [k, v.replace(/^"|"$/g, '')]),
    );
    if (fm.status === 'draft') continue;   // a draft is not published, so it is not searchable

    let body = m[2];
    // Figures carry a whole SVG or an <img>; their text is markup, not prose. The caption is
    // kept because a reader searching for what a diagram shows should find the page.
    body = body.replace(/<figure[\s\S]*?<figcaption>([\s\S]*?)<\/figcaption><\/figure>/g, ' $1 ');
    body = body.replace(/<figure[\s\S]*?<\/figure>/g, ' ');
    const headings = [...body.matchAll(/^#{2,4}\s+(.+)$/gm)].map(([, h]) => h.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trim());
    const text = body
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`>|-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    docs.push({
      path: relative(CONTENT, file).replace(/\.md$/, ''),
      title: fm.title ?? '',
      section: fm.section ?? '',
      excerpt: fm.excerpt ?? '',
      headings,
      text,
    });
  }
  return docs;
}

function main(): void {
  const docs = buildIndex();
  const json = JSON.stringify({ built: docs.length, docs }, null, 0) + '\n';
  if (CHECK) {
    const existing = (() => { try { return readFileSync(OUT, 'utf8'); } catch { return ''; } })();
    if (existing !== json) { console.error(`✗ search index is stale. Run: npm run docs:search-index`); process.exit(1); }
    console.log(`✓ search index current — ${docs.length} pages.`);
    return;
  }
  writeFileSync(OUT, json, 'utf8');
  const kb = (json.length / 1024).toFixed(0);
  console.log(`✓ indexed ${docs.length} pages -> static/docs-search-index.json (${kb} KB)`);
  // The size matters: this file is fetched by anyone who opens search, so it should stay small
  // enough to be worth fetching. If it grows past a few hundred KB, split it or index headings only.
  if (json.length > 400_000) console.log(`  ⚠ over 400 KB — consider trimming body text before it costs a reader real time.`);
}

if (process.argv[1] && process.argv[1].endsWith('docs-search-index.ts')) main();
