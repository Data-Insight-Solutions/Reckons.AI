/**
 * Site build (F274.4.1) — a site repository's content/ into static HTML with the
 * Reckons.AI engine. The host-side library behind npm run site:build.
 *
 *   reads    every markdown file under <site>/content/, through site-import, into WebPage triples
 *   renders  with the existing generator (generateStaticSite) — this module adds
 *            no rendering of its own (F274.4.1 non-goal: "it uses the generator's
 *            existing output")
 *   copies   <site>/assets/ and <site>/admin/ byte-for-byte (a missing folder is
 *            skipped, not an error)
 *   writes   _headers — the project's Cloudflare Pages hardening convention
 *   and swaps the result into <out> atomically
 *
 * Draft pages are already filtered by the generator's publishablePages; this module
 * adds no second filter — the done-test asserts the draft appears in no output file.
 *
 * Output writing follows the ownership/atomicity pattern of scripts/lib/site-output.ts
 * (stage in a temp dir, refuse directories we do not own), extended with binary-safe
 * copies: that writer takes string maps only, and cover images are not strings.
 */
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { generateStaticSite } from './site-generator';
import { createBlogExtension, importSiteWithBlog } from './site-blog';
import { loadSiteConfig } from './site-config';

export interface SiteBuildOptions {
  /** Site repository directory — must contain a content/ folder of markdown pages. */
  site: string;
  /** Output directory — fresh, empty, or a previous site:build output. */
  out: string;
  /** Passed to the generator as the site title (optional). */
  siteTitle?: string;
  /**
   * LOCAL PREVIEW ONLY (F274.4.2): include draft pages, marked "Draft", with noindex on every page
   * and X-Robots-Tag in _headers. The output is stamped DRAFT_PREVIEW_MARKER and the manifest records
   * it; assertNotDraftPreview() refuses such a directory in any deploy path. Default false.
   */
  includeDrafts?: boolean;
  /** Path to a JSON file whose top-level keys are merged over site.config.json at build time (`webhook` is shorthand for contact.webhook). Only the merged values reach the output, never the path. */
  configOverride?: string;
}

/** Present in the output of an includeDrafts build; a deploy path must refuse a directory holding it. */
export const DRAFT_PREVIEW_MARKER = 'DRAFT-PREVIEW-NOT-FOR-DEPLOY.txt';

/** Throw when <dir> is a draft-preview build. Call it before handing a directory to any deploy command. */
export function assertNotDraftPreview(dir: string): void {
  if (existsSync(join(dir, DRAFT_PREVIEW_MARKER))) {
    throw new Error(
      'refusing to deploy ' + dir + ': it is a --drafts preview build (' + DRAFT_PREVIEW_MARKER +
      '). Rebuild without --drafts.',
    );
  }
}

export interface SiteBuildResult {
  out: string;
  pageCount: number;
  /** Every path written to the output, site-relative, sorted. */
  files: string[];
  copiedAssets: number;
  copiedAdmin: number;
}

const MANIFEST_NAME = '.reckons-site-build.json';
const MANIFEST_FORMAT = 'reckons-site-build-v1';

interface SiteBuildManifest {
  format: string;
  files: string[];
  draftPreview?: boolean;
}

/** Recursively list a directory as sorted POSIX-relative paths (files only). */
function listTree(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const rest of listTree(join(dir, entry.name))) out.push(entry.name + '/' + rest);
    } else {
      out.push(entry.name);
    }
  }
  return out.sort();
}

function fail(msg: string): never {
  throw new Error('site:build: ' + msg);
}

/** A symlink in the input tree could point outside the site — refuse it. */
function assertNoSymlink(rel: string, abs: string, where: string): void {
  if (lstatSync(abs).isSymbolicLink()) fail('refusing symlink in ' + where + '/: ' + rel);
}

/**
 * Read every markdown file under <site>/content/ into the site-import file map (keys: content/<rel>).
 * A site without content/, or with no markdown pages, is an error — not an empty build.
 */
export function readSiteContent(site: string): Record<string, string> {
  const contentDir = join(site, 'content');
  if (!existsSync(contentDir) || !statSync(contentDir).isDirectory()) {
    fail('no content/ directory in ' + site + ' — a site repository must contain content/*.md');
  }
  const files: Record<string, string> = {};
  for (const rel of listTree(contentDir)) {
    if (!rel.endsWith('.md')) continue;
    const abs = join(contentDir, rel);
    assertNoSymlink(rel, abs, 'content');
    files['content/' + rel] = readFileSync(abs, 'utf8');
  }
  if (Object.keys(files).length === 0) fail('content/ in ' + site + ' has no markdown pages');
  return files;
}

/**
 * The _headers file — the project's Cloudflare Pages hardening convention
 * (static/_headers), with the app-specific CSP note restated for this context:
 * CSP is deliberately NOT a response header, because the generator puts it in each
 * page's meta tag, and duplicating it as a header risks divergence.
 */
export function siteHeaders(draftPreview = false): string {
  const HASH = String.fromCharCode(35);
  return [
    HASH + ' Generated by Reckons.AI site:build (F274.4.1) — do not hand-edit.',
    HASH + ' Cloudflare Pages response headers.',
    HASH + ' CSP is intentionally NOT written here — it lives in each page meta tag (see the generator).',
    '/*',
    '  Strict-Transport-Security: max-age=63072000; includeSubDomains',
    '  X-Frame-Options: SAMEORIGIN',
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    ...(draftPreview ? ['  X-Robots-Tag: noindex, nofollow'] : []),
    '',
  ].join('\n');
}

/**
 * Copy <site>/<name>/** into the stage, byte-for-byte, preserving structure.
 * Returns the site-relative paths copied (under <name>/). Missing folder = zero copies.
 */
function copyTreeIntoStage(site: string, stage: string, name: string): string[] {
  const src = join(site, name);
  if (!existsSync(src) || !statSync(src).isDirectory()) return [];
  const copied: string[] = [];
  for (const rel of listTree(src)) {
    const from = join(src, rel);
    assertNoSymlink(rel, from, name);
    const dest = join(stage, name, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) fail('staging collision for ' + name + '/' + rel);
    copyFileSync(from, dest);
    copied.push(name + '/' + rel);
  }
  return copied;
}

function readManifest(dir: string): SiteBuildManifest | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, MANIFEST_NAME), 'utf8')) as SiteBuildManifest;
    if (raw && raw.format === MANIFEST_FORMAT && Array.isArray(raw.files)) return raw;
    return null;
  } catch {
    return null;
  }
}

/** Every path already in <dir> must be one we wrote on a previous build. */
function verifyOwned(dir: string, manifest: SiteBuildManifest): void {
  const owned = new Set<string>(manifest.files);
  owned.add(MANIFEST_NAME);
  for (const rel of listTree(dir)) {
    if (!owned.has(rel)) {
      fail(
        rel + ' in the output directory is not from a previous site:build — ' +
        'refusing to replace a directory we do not own',
      );
    }
  }
}

function readOverride(path?: string): Record<string, unknown> | undefined {
  if (!path) return undefined;
  let v: unknown;
  try { v = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('config override is not readable JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('config override must be a JSON object');
  return v as Record<string, unknown>;
}

export function buildSite(opts: SiteBuildOptions): SiteBuildResult {
  const site = resolve(opts.site);
  const out = resolve(opts.out);

  if (!existsSync(site) || !statSync(site).isDirectory()) fail('site directory not found: ' + site);
  if (existsSync(out) && !statSync(out).isDirectory()) fail('output exists and is not a directory: ' + out);

  // The output must not sit inside the site: we read the site while staging the output.
  const inside = relative(site, out);
  if (inside === '' || (inside !== '..' && !inside.startsWith('..') && !inside.startsWith('/'))) {
    fail('output must not be inside the site directory (' + out + ')');
  }

  const content = readSiteContent(site);
  const stmts = importSiteWithBlog(content);
  const blog = createBlogExtension(stmts);
  const drafts = opts.includeDrafts === true;
  let generated: ReturnType<typeof generateStaticSite>;
  try {
    generated = generateStaticSite(stmts, { siteTitle: opts.siteTitle, extension: blog, includeDrafts: drafts, siteConfig: loadSiteConfig(site, readOverride(opts.configOverride)) ?? undefined });
  } catch (err) {
    fail((err as Error).message);
  }
  if (generated.pageCount === 0) {
    fail('no published pages in ' + site + ' (every content page is draft?) — nothing to build');
  }
  // A cover that resolves to no file is a build error, not a broken image on the live site.
  const missing = blog.requiredCovers().filter((c) => {
    const abs = join(site, c.file);
    return !existsSync(abs) || !statSync(abs).isFile();
  });
  if (missing.length > 0) {
    fail(
      'cover image(s) resolve to no file (cover paths resolve against assets/):\n' +
      missing.map((c) => '  ' + c.post + ': coverImage "' + c.cover + '" -> ' + c.file).join('\n'),
    );
  }

  // Stage everything, then swap into <out>: the output is a faithful image of the site
  // at build time, so a page that became a draft between builds cannot survive in <out>.
  const files: Record<string, string> = { ...generated.files, _headers: siteHeaders(drafts) };
  if (drafts) {
    files[DRAFT_PREVIEW_MARKER] =
      'This directory is a LOCAL PREVIEW built with --drafts. It contains unpublished draft pages.\n' +
      'Do not deploy it. site:build without --drafts produces the deployable output.\n';
  }
  const stage = mkdtempSync(join(tmpdir(), 'reckons-site-build-'));
  try {
    for (const [rel, text] of Object.entries(files)) {
      const dest = join(stage, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, text, { flag: 'wx' });
    }
    const copiedAssets = copyTreeIntoStage(site, stage, 'assets');
    const copiedAdmin = copyTreeIntoStage(site, stage, 'admin');

    const all = [...Object.keys(files), ...copiedAssets, ...copiedAdmin, MANIFEST_NAME].sort();
    const manifest: SiteBuildManifest = { format: MANIFEST_FORMAT, files: all, ...(drafts ? { draftPreview: true } : {}) };
    writeFileSync(join(stage, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });

    if (existsSync(out) && listTree(out).length > 0) {
      const prev = readManifest(out);
      if (prev === null) {
        fail(out + ' is not a site:build output (no ' + MANIFEST_NAME + ') — refusing to overwrite it');
      }
      verifyOwned(out, prev);
      const trash = mkdtempSync(join(dirname(out), 'reckons-site-build-trash-'));
      renameSync(out, trash);
      try {
        renameSync(stage, out);
      } catch (err) {
        renameSync(trash, out);
        throw err;
      }
      rmSync(trash, { recursive: true, force: true });
    } else {
      mkdirSync(dirname(out), { recursive: true });
      renameSync(stage, out);
    }

    return { out, pageCount: generated.pageCount, files: all, copiedAssets: copiedAssets.length, copiedAdmin: copiedAdmin.length };
  } catch (err) {
    rmSync(stage, { recursive: true, force: true });
    throw err;
  }
}
