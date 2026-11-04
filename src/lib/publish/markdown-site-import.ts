/**
 * Markdown-blog import — a GENERIC, PURE frontmatter → WebPage importer.
 *
 * Where `site-import.ts` round-trips Reckons.AI's *own* `content/*.md`, this module takes
 * an *existing* blog — a folder of `.md` posts from a SvelteKit/mdsvex, Hugo, Jekyll or
 * Eleventy site — and turns them into WebPage facts. It reads nothing from disk: callers
 * pass a `{ path → file text }` map, so the same function works in the browser, in a CLI,
 * and in a test. No new dependencies — the frontmatter parser below is small and handles
 * the shapes real blog frontmatter uses.
 *
 * The core page facts (type, label, slug, section, template, status, nav, excerpt, date,
 * body) come from `importSitePages` — this module does NOT re-mint IRIs; it appends only
 * the two page predicates that a blog carries but Reckons.AI's own round-trip does not:
 * `page:category` (one per category) and `page:cover-image`.
 */

import type { PageStatus, PageTemplate } from '../rdf/page';
import { PAGE_CATEGORY, PAGE_COVER } from '../rdf/page';
import type { ReviewStatus, Statement } from '../rdf/types';
import { iri, lit } from '../rdf/types';
import type { ParsedPageFile } from './site-import';
import { importSitePages } from './site-import';

export interface MarkdownSiteOptions {
  /** Nav group the imported posts land in (default `'blog'`). */
  section?: string;
  /** Page template for each post (default `'post'` — dated, reverse-chronological). */
  template?: PageTemplate;
  /** Publish status stamped on each post (default `'draft'` — imported text is unreviewed). */
  status?: PageStatus;
}

export interface MarkdownSiteResult {
  statements: Statement[];
  /** Number of posts successfully imported (a post with no title is not counted). */
  pages: number;
  /** Human-readable warnings (skipped posts, bad dates, non-markdown body lines). */
  warnings: string[];
}

// ── Frontmatter parsing ──────────────────────────────────────────────────────

interface RawPostFrontmatter {
  title?: string;
  date?: string;
  excerpt?: string;
  description?: string;
  categories?: string[];
  tags?: string[];
  coverImage?: string;
  image?: string;
  cover?: string;
}

/** Strip matching surrounding quotes — double (JSON-style escapes) or single (YAML `''`). */
function unquote(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if (first === '"' && last === '"') {
      try {
        return JSON.parse(t) as string;
      } catch {
        /* fall through to a plain strip */
      }
      return t.slice(1, -1);
    }
    if (first === "'" && last === "'") return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/**
 * Parse a blog frontmatter block into the few fields the importer maps.
 *
 * Handles the three shapes real frontmatter uses: a `key: value` scalar (quotes stripped);
 * a `key:` line that opens a list of `  - value` items; and a list item that is itself a
 * single-key object (`  - categoryName: Technology`), flattened to its value. Any other key
 * is ignored — forward-compatible with hand-edits, like `parseFrontmatterBlock` does.
 */
function parsePostFrontmatter(header: string): RawPostFrontmatter {
  const fm: RawPostFrontmatter = {};
  let listKey: 'categories' | 'tags' | null = null;

  for (const rawLine of header.split(/\r?\n/)) {
    // A list item belongs to the most recent `key:` that opened a list.
    const listItem = /^ {2,}-\s*(.*)$/.exec(rawLine);
    if (listItem && listKey) {
      let value = listItem[1].trim();
      // Single-key object (`- categoryName: Technology`) → keep the value, drop the key.
      const obj = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(value);
      if (obj) value = obj[2].trim();
      value = unquote(value);
      if (value) (fm[listKey] ??= []).push(value);
      continue;
    }
    listKey = null;

    const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(rawLine);
    if (!kv) continue;
    const key = kv[1];
    const rawVal = kv[2].trim();

    // `key:` with nothing after opens a list block (categories/tags only).
    if (rawVal === '') {
      if (key === 'categories' || key === 'tags') {
        listKey = key;
        fm[key] = fm[key] ?? [];
      }
      continue;
    }

    const val = unquote(rawVal);
    switch (key) {
      case 'title': fm.title = val; break;
      case 'date': fm.date = val; break;
      case 'excerpt': fm.excerpt = val; break;
      case 'description': fm.description = val; break;
      case 'coverImage': fm.coverImage = val; break;
      case 'image': fm.image = val; break;
      case 'cover': fm.cover = val; break;
      case 'categories':
      case 'tags':
        (fm[key] ??= []).push(val);
        break;
      default:
        break; // unknown key — ignore
    }
  }

  return fm;
}

/**
 * Split a markdown file into its frontmatter header (between the first two `---` lines),
 * its body, and the 1-indexed file line number where the body starts. Returns null when the
 * file does not open with a frontmatter block (the whole file is then an untitled body).
 */
function splitPostFile(source: string): { header: string; body: string; bodyStartLine: number } | null {
  const lines = source.split(/\r?\n/);
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return null;
  return {
    header: lines.slice(1, closeIdx).join('\n'),
    body: lines.slice(closeIdx + 1).join('\n'),
    bodyStartLine: closeIdx + 2, // 1-indexed line of the first body line
  };
}

const ISO_DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}$/;
const BODY_MARKUP_PREFIXES = ['<script', '<style', '{#', 'import '];

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Turn a `{ path → markdown }` map (only `.md` keys are read) into WebPage facts for
 * the blog posts it names. Pure and synchronous — no file system. Posts default to `draft` status
 * because their text has not been reviewed in Reckons.AI yet.
 */
export function importMarkdownSite(
  files: Record<string, string>,
  opts: MarkdownSiteOptions = {},
): MarkdownSiteResult {
  const section = opts.section ?? 'blog';
  const template = opts.template ?? 'post';
  const status = opts.status ?? 'draft';
  const warnings: string[] = [];

  const mdEntries = Object.entries(files)
    .filter(([path]) => path.endsWith('.md'))
    .sort(([a], [b]) => a.localeCompare(b));

  const parsed: ParsedPageFile[] = [];
  const categoriesBySlug = new Map<string, string[]>();
  const coverBySlug = new Map<string, string>();

  for (const [path, source] of mdEntries) {
    const fileName = path.split('/').pop() ?? path;
    const slug = fileName.replace(/\.md$/, ''); // keep the slug exact — old URLs must survive

    const split = splitPostFile(source);
    const header = split?.header ?? '';
    const rawBody = split ? split.body : source;
    const body = rawBody.trim();
    const bodyStartLine = split?.bodyStartLine ?? 1;

    const fm = parsePostFrontmatter(header);
    if (!fm.title || !fm.title.trim()) {
      warnings.push(`skipped ${path}: no title in frontmatter`);
      continue;
    }

    // Body lines that are component/markup syntax will not render as markdown — keep the post,
    // but name the file and line so the mover can fix it.
    const bodyLines = rawBody.split(/\r?\n/);
    for (let j = 0; j < bodyLines.length; j++) {
      if (BODY_MARKUP_PREFIXES.some((p) => bodyLines[j].startsWith(p))) {
        warnings.push(`${path}:${bodyStartLine + j} — component/markup syntax will not render as markdown: ${bodyLines[j].trim()}`);
      }
    }

    let date: string | null = null;
    if (fm.date !== undefined && fm.date.trim() !== '') {
      const prefix = fm.date.trim().slice(0, 10); // `2026-01-10T10:00` → `2026-01-10`
      if (ISO_DATE_PREFIX_RE.test(prefix)) date = prefix;
      else warnings.push(`${path}: date "${fm.date}" is not YYYY-MM-DD; no date recorded`);
    }

    const categories = (fm.categories ?? fm.tags ?? []).filter((c) => c && c.trim() !== '');
    if (categories.length) categoriesBySlug.set(slug, categories);
    const cover = fm.coverImage ?? fm.image ?? fm.cover;
    if (cover && cover.trim() !== '') coverBySlug.set(slug, cover.trim());

    parsed.push({
      title: fm.title.trim(),
      slug,
      order: 0,
      section,
      parentSlug: null,
      template,
      status,
      nav: 'hidden', // imported posts do not enter the visible nav until reviewed
      excerpt: (fm.excerpt ?? fm.description ?? '').trim(),
      relatedSlugs: [],
      body,
      date,
      generated: null,
    });
  }

  const statements = importSitePages(parsed, { sourceId: 'markdown-site-import' });

  // Append the two blog-specific predicates for the SAME subject IRIs importSitePages minted
  // (its default is `urn:kbase:concept/<slug>` — we do not mint them any other way).
  const sourceId = 'markdown-site-import';
  const reviewStatus: ReviewStatus = 'confirmed';
  const g = iri(`urn:kbase:source/${sourceId}`);
  const now = Date.now();
  let n = statements.length; // id counter continues past the core page facts
  const append = (subject: string, predicate: string, object: string): void => {
    n += 1;
    statements.push({
      id: `${sourceId}-${n}`,
      s: iri(subject),
      p: iri(predicate),
      o: lit(object),
      g,
      sourceId,
      confidence: 1,
      status: reviewStatus,
      createdAt: now,
      updatedAt: now,
    });
  };

  for (const f of parsed) {
    const subject = `urn:kbase:concept/${f.slug}`;
    for (const category of categoriesBySlug.get(f.slug) ?? []) append(subject, PAGE_CATEGORY, category);
    const cover = coverBySlug.get(f.slug);
    if (cover) append(subject, PAGE_COVER, cover);
  }

  return { statements, pages: parsed.length, warnings };
}
