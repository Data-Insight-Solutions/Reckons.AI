#!/usr/bin/env npx tsx
/**
 * Markdown alignment check — F27 Graph Publishing.
 *
 * The graph is the source of truth for `content/<section>/<slug>.md`; those
 * files are a generated, trailing by-product (see kb:graph-publishing in
 * static/reckons-roadmap.ttl). CI can't read a contributor's IndexedDB graph,
 * so this check uses the checked-in markdown itself as the reference: it
 * imports every `content/**\/*.md` file back into WebPage statements
 * (`src/lib/publish/site-import.ts`), re-exports them
 * (`src/lib/publish/site-export.ts`), and diffs the regenerated markdown
 * against the original bytes.
 *
 * A clean pass means every committed file is exactly what `site-export`
 * would produce from its own frontmatter+body — i.e. no one hand-edited the
 * file outside the graph/CMS round trip in a way that changed its shape.
 * (It does *not* prove the frontmatter matches someone's live graph — only
 * that the file is internally consistent with the export format.)
 *
 * Usage:
 *   npx tsx scripts/md-align.ts
 *
 * Exit code: 0 = aligned (or no content files beyond the starter), 1 = drift found.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { importSiteFiles } from '../src/lib/publish/site-import';
import { buildSiteFiles } from '../src/lib/publish/site-export';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const CONTENT_DIR = join(ROOT, 'content');

// ── Colours (disabled outside a TTY / when NO_COLOR is set, e.g. CI logs) ────

const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const C = USE_COLOR
  ? { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' }
  : { reset: '', green: '', red: '', yellow: '', dim: '', bold: '' };
const ok = (s: string) => `${C.green}${s}${C.reset}`;
const fail = (s: string) => `${C.red}${s}${C.reset}`;
const dim = (s: string) => `${C.dim}${s}${C.reset}`;
const bold = (s: string) => `${C.bold}${s}${C.reset}`;

// ── Walk content/ ─────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

function loadContentFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const abs of walk(CONTENT_DIR)) {
    const relPath = relative(ROOT, abs).split(sep).join('/'); // posix-normalize for Windows runners
    files[relPath] = readFileSync(abs, 'utf8');
  }
  return files;
}

// ── Minimal line diff (readability only — not a real LCS diff) ──────────────

function lineDiff(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const max = Math.max(a.length, b.length);
  const out: string[] = [];
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined) out.push(fail(`  - ${a[i]}`));
    if (b[i] !== undefined) out.push(ok(`  + ${b[i]}`));
  }
  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
  console.log(bold('Markdown Alignment Check') + dim(' (content/*.md vs. graph round-trip)'));

  const originals = loadContentFiles();
  const paths = Object.keys(originals).sort();

  if (paths.length === 0) {
    console.log(dim('\nNo content/*.md files found — nothing to check.'));
    process.exit(0);
  }

  const onlyStarter = paths.length === 1 && paths[0] === 'content/docs/welcome.md';

  const imported = importSiteFiles(originals);
  // includeDrafts + no admin: regenerate every file regardless of page:status,
  // since we're checking every committed .md, not just the publishable subset.
  const regenerated = buildSiteFiles(imported, { includeDrafts: true, includeAdmin: false });

  const drifted: Array<{ path: string; reason: string; diff: string[] }> = [];
  for (const path of paths) {
    const before = originals[path];
    const after = regenerated[path];
    if (after === undefined) {
      drifted.push({
        path,
        reason: 'regenerated output has no matching file (parsing produced an unexpected slug/section, or duplicate slug collision)',
        diff: [],
      });
      continue;
    }
    if (after !== before) {
      drifted.push({ path, reason: 'content differs from its graph-regenerated form', diff: lineDiff(before, after) });
    }
  }

  console.log(dim(`\nChecked ${paths.length} file(s):`));
  for (const path of paths) console.log(dim(`  ${path}`));

  if (drifted.length === 0) {
    console.log(`\n${ok(`Aligned — all ${paths.length} content file(s) match the graph-generated form.`)}`);
    if (onlyStarter) {
      console.log(dim('Only the starter content/docs/welcome.md is present — trivially aligned.'));
    }
    process.exit(0);
  }

  console.log(`\n${fail(`Drift detected in ${drifted.length}/${paths.length} file(s):`)}\n`);
  for (const d of drifted) {
    console.log(`${fail('!')} ${bold(d.path)} ${dim(`— ${d.reason}`)}`);
    for (const line of d.diff) console.log(line);
    console.log();
  }
  console.log(dim('Fix: re-export these pages from the graph (publishSiteToGitHub / exportSiteZip) and commit the result.'));
  process.exit(1);
}

main();
