/**
 * Site export — turn WebPage graph nodes into a static site's source files.
 *
 * Graph-first publishing (see plan "Sveltia CMS Publishing"): the graph is the
 * source of truth. This module serializes `ktype:WebPage` nodes to a Git repo layout
 *
 *   content/<section>/<slug>.md   — frontmatter + long-form markdown body
 *   graph.json                    — page nodes/edges for the theme's graph view
 *   admin/config.yml + index.html — Sveltia CMS wiring (external bundle, un-forked)
 *
 * Two paths: `exportSiteZip` (offline — download a .zip, no internet needed) and
 * `publishSiteToGitHub` (online — PUT files to a site repo the CMS edits).
 *
 * Pure builders (`buildSiteFiles`, `pageToMarkdown`, `buildGraphJson`, `zipSiteBytes`)
 * are side-effect-free for testing; download/network live in the exported wrappers.
 */

import { zipSync, strToU8 } from 'fflate';
import type { Statement } from '../rdf/types';
import { buildSitePages, publishablePages, slugify, type SitePage } from '../rdf/page';
import { parseRepoUrl, type RepoRef } from '../integrations/github/repo-ingest';
import { toTurtle } from '../rdf/serialize';
import { filterBlockedStatements } from '../safety/content-policy';

/** Root-relative path of the self-describing published graph (F72 kb:published-ttl).
 * Every published page advertises it via <link rel="alternate" type="text/turtle">
 * so another Reckons.AI can Add-from-URL and import the facts with no LLM. */
export const PUBLISHED_TTL_PATH = 'knowledge.ttl';

const GITHUB_API = 'https://api.github.com';

/** Pinned Sveltia CMS bundle — external dependency, never vendored into this repo. */
export const SVELTIA_CMS_CDN = 'https://unpkg.com/@sveltia/cms/dist/sveltia-cms.js';

export interface SiteExportOptions {
  siteTitle?: string;
  /** GitHub repo the CMS commits to, "owner/repo" — required for a working admin/config.yml */
  repo?: string;
  branch?: string;
  /** Include admin/ Sveltia scaffolding (default true) */
  includeAdmin?: boolean;
  /** Publish drafts too (default false — only published/unlisted go out) */
  includeDrafts?: boolean;
}

// ── Path + slug helpers ──────────────────────────────────────────────────────

/** Repo-relative content path for a page: content/<section>/<slug>.md */
export function contentPath(page: SitePage): string {
  const section = page.section ? `${slugify(page.section)}/` : '';
  return `content/${section}${page.slug}.md`;
}

function slugMap(pages: SitePage[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const p of pages) m.set(p.iri, p.slug);
  return m;
}

// ── Markdown / frontmatter ───────────────────────────────────────────────────

/** YAML-encode a scalar string value (double-quoted, escaped). */
function yamlStr(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Serialize a page to markdown with YAML frontmatter. `slugs` resolves the parent
 * IRI (and related IRIs) to slugs so the file references portable slugs, not IRIs.
 */
export function pageToMarkdown(page: SitePage, slugs: Map<string, string>): string {
  const lines: string[] = ['---'];
  lines.push(`title: ${yamlStr(page.title)}`);
  lines.push(`slug: ${yamlStr(page.slug)}`);
  lines.push(`order: ${page.order}`);
  if (page.section) lines.push(`section: ${yamlStr(page.section)}`);
  const parentSlug = page.parent ? slugs.get(page.parent) : undefined;
  if (parentSlug) lines.push(`parent: ${yamlStr(parentSlug)}`);
  lines.push(`template: ${page.template}`);
  lines.push(`status: ${page.status}`);
  lines.push(`nav: ${page.nav}`);
  if (page.date) lines.push(`date: ${yamlStr(page.date)}`);
  if (page.excerpt) lines.push(`excerpt: ${yamlStr(page.excerpt)}`);
  if (page.generated) lines.push(`generated: ${yamlStr(page.generated)}`);
  const related = page.related.map((r) => slugs.get(r)).filter((s): s is string => !!s);
  if (related.length) {
    lines.push('related:');
    for (const r of related) lines.push(`  - ${yamlStr(r)}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(page.body || `# ${page.title}\n`);
  return lines.join('\n');
}

// ── Graph JSON (theme's interactive graph view) ──────────────────────────────

export interface SiteGraph {
  nodes: Array<{ id: string; title: string; section: string; template: string; status: string }>;
  edges: Array<{ from: string; to: string; kind: 'parent' | 'related' | 'next' }>;
}

export function buildGraphJson(pages: SitePage[]): SiteGraph {
  const slugs = slugMap(pages);
  const nodes = pages.map((p) => ({
    id: p.slug, title: p.title, section: p.section, template: p.template, status: p.status,
  }));
  const edges: SiteGraph['edges'] = [];
  for (const p of pages) {
    if (p.parent && slugs.has(p.parent)) edges.push({ from: p.slug, to: slugs.get(p.parent)!, kind: 'parent' });
    for (const r of p.related) if (slugs.has(r)) edges.push({ from: p.slug, to: slugs.get(r)!, kind: 'related' });
    if (p.next && slugs.has(p.next)) edges.push({ from: p.slug, to: slugs.get(p.next)!, kind: 'next' });
  }
  return { nodes, edges };
}

// ── Sveltia CMS scaffolding ──────────────────────────────────────────────────

export function sveltiaConfig(opts: SiteExportOptions): string {
  const repo = opts.repo ?? 'OWNER/REPO';
  const branch = opts.branch ?? 'main';
  return [
    'backend:',
    '  name: github',
    `  repo: ${repo}`,
    `  branch: ${branch}`,
    '',
    'media_folder: static/media',
    'public_folder: /media',
    '',
    'collections:',
    '  - name: pages',
    '    label: Pages',
    '    folder: content',
    '    create: true',
    // Sveltia CMS does not implement Decap's `nested` collection option (planned
    // for a future 2.0) — it is silently ignored, leaving the collection with no
    // entries whenever files live below the top-level folder. `path` is the
    // option Sveltia supports for subfoldered entries: it discovers existing
    // files recursively and places new ones, no per-entry index file required.
    // `slugify` mirrors contentPath()'s `slugify(page.section)` above so the
    // folder segment matches what's actually on disk (e.g. "Docs" -> docs/).
    "    path: '{{fields.section | slugify}}/{{fields.slug}}'",
    '    identifier_field: slug',
    '    fields:',
    '      - { name: title, label: Title, widget: string }',
    '      - { name: slug, label: Slug, widget: string }',
    '      - { name: order, label: Order, widget: number, default: 0, value_type: int }',
    '      - { name: section, label: Section, widget: string, required: false }',
    '      - { name: parent, label: Parent slug, widget: string, required: false }',
    '      - { name: template, label: Template, widget: select, options: [landing, doc, full, sidebar, post], default: doc }',
    '      - { name: status, label: Status, widget: select, options: [draft, published, unlisted], default: draft }',
    '      - { name: nav, label: Nav placement, widget: select, options: [menu, sidebar, both, hidden], default: sidebar }',
    '      - { name: date, label: Date, widget: datetime, format: "YYYY-MM-DD", time_format: false, required: false, hint: "Posts only — release notes/announcements/blog publish date" }',
    '      - { name: excerpt, label: Excerpt, widget: text, required: false }',
    '      - { name: body, label: Body, widget: markdown }',
    '      - { name: generated, label: "Generated (docs graph — do not edit)", widget: hidden, required: false }',
    '',
  ].join('\n');
}

export function sveltiaAdminHtml(): string {
  // Loads the external, un-forked Sveltia CMS bundle. Thanks to the Sveltia project —
  // https://github.com/sveltia/sveltia-cms (please consider sponsoring).
  return [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    '    <title>Content Manager</title>',
    '  </head>',
    '  <body>',
    `    <script src="${SVELTIA_CMS_CDN}"></script>`,
    '  </body>',
    '</html>',
    '',
  ].join('\n');
}

// ── File-set builder ─────────────────────────────────────────────────────────

/** Build the full repo-relative file map for the site. */
export function buildSiteFiles(stmts: Statement[], opts: SiteExportOptions = {}): Record<string, string> {
  const all = buildSitePages(stmts);
  const pages = opts.includeDrafts ? all : publishablePages(all);
  const slugs = slugMap(pages);

  const files: Record<string, string> = {};
  for (const page of pages) {
    files[contentPath(page)] = pageToMarkdown(page, slugs);
  }
  files['graph.json'] = JSON.stringify(buildGraphJson(pages), null, 2);

  // Self-describing graph (F72 kb:published-ttl): serialize the published facts to
  // Turtle so a reader can Add-from-URL and import them directly (no LLM). Run the
  // publish-safety filter first — never emit blocked statements to the open web.
  const { allowed: safeStmts } = filterBlockedStatements(stmts);
  files[PUBLISHED_TTL_PATH] = toTurtle(safeStmts, {
    header: '# Reckons.AI published graph — import via Add-from-URL (no LLM extraction).\n',
  });

  if (opts.includeAdmin !== false) {
    files['admin/config.yml'] = sveltiaConfig(opts);
    files['admin/index.html'] = sveltiaAdminHtml();
  }
  return files;
}

/** Zip the site file-set into bytes (offline export). */
export function zipSiteBytes(stmts: Statement[], opts: SiteExportOptions = {}): Uint8Array {
  const files = buildSiteFiles(stmts, opts);
  const zippable: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(files)) zippable[path] = strToU8(content);
  return zipSync(zippable, { level: 6 });
}

// ── Offline: download .zip ───────────────────────────────────────────────────

/** Trigger a browser download of the site as a .zip (offline path). No-op outside a browser. */
export function exportSiteZip(stmts: Statement[], opts: SiteExportOptions = {}): void {
  if (typeof document === 'undefined') return;
  const bytes = zipSiteBytes(stmts, opts);
  const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${slugify(opts.siteTitle ?? 'reckons-site')}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Online: publish to GitHub ────────────────────────────────────────────────

function ghHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** base64-encode a UTF-8 string for the GitHub contents API. */
function toBase64(content: string): string {
  const bytes = strToU8(content);
  if (typeof btoa === 'function') {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  // Node fallback
  return Buffer.from(content, 'utf8').toString('base64');
}

async function getFileSha(ref: RepoRef, path: string, token: string): Promise<string | undefined> {
  const branch = ref.branch ?? 'main';
  const res = await fetch(
    `${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { headers: ghHeaders(token) },
  );
  if (!res.ok) return undefined; // 404 = new file
  const json = (await res.json()) as { sha?: string };
  return json.sha;
}

export interface PublishResult {
  written: string[];
  repo: string;
  branch: string;
}

/**
 * Publish the site file-set to a GitHub repo via the contents API (create/update).
 * Reuses `parseRepoUrl`/`RepoRef` from the github integration; `token` is the
 * existing `githubToken` setting.
 */
export async function publishSiteToGitHub(
  repoInput: string,
  token: string,
  stmts: Statement[],
  opts: SiteExportOptions = {},
): Promise<PublishResult> {
  const ref = parseRepoUrl(repoInput);
  if (!ref) throw new Error(`Invalid repo: ${repoInput}`);
  if (!token) throw new Error('A GitHub token is required to publish.');
  const branch = ref.branch ?? opts.branch ?? 'main';

  const files = buildSiteFiles(stmts, { ...opts, repo: `${ref.owner}/${ref.repo}`, branch });
  const written: string[] = [];

  for (const [path, content] of Object.entries(files)) {
    const sha = await getFileSha(ref, path, token);
    const res = await fetch(`${GITHUB_API}/repos/${ref.owner}/${ref.repo}/contents/${path}`, {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `chore(site): publish ${path} from Reckons.AI`,
        content: toBase64(content),
        branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to write ${path}: ${res.status} ${await res.text()}`);
    }
    written.push(path);
  }

  return { written, repo: `${ref.owner}/${ref.repo}`, branch };
}
