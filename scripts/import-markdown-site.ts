#!/usr/bin/env npx tsx
/**
 * `import-markdown-site` — a GENERIC importer: a folder of existing blog markdown (SvelteKit/mdsvex,
 * Hugo, Jekyll, Eleventy — anything that keeps `.md` posts with YAML frontmatter) in, a Reckons.AI
 * WebPage `.ttl` out. Script tier — no model; the mapping is rules.
 *
 *   npx tsx scripts/import-markdown-site.ts --from=<blog folder> --out=<posts.ttl>
 *   npx tsx scripts/import-markdown-site.ts --from=./blog --out=posts.ttl --section=blog --template=post --status=draft
 *   npx tsx scripts/import-markdown-site.ts --from=./blog --out=posts.ttl --force     # overwrite posts.ttl
 *
 * Posts default to `draft` status — imported text is unreviewed. Every `.md` under `--from` is read
 * (recursive); the pure mapper is `src/lib/publish/markdown-site-import.ts`. The output file already
 * existing is a refusal, not an overwrite, unless `--force`.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import path from 'path';
import { importMarkdownSite } from '../src/lib/publish/markdown-site-import.js';
import type { PageStatus, PageTemplate } from '../src/lib/rdf/page.js';
import { toTurtle } from '../src/lib/rdf/serialize.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m';
const argv = process.argv.slice(2);
const flag = (name: string, def = ''): string => argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? def;
const has = (name: string) => argv.includes(`--${name}`);

const fromDir = flag('from');
const outFile = flag('out');
if (!fromDir || !outFile) {
  console.error(`Usage: npx tsx scripts/import-markdown-site.ts --from=<folder> --out=<file.ttl> [--section=blog] [--template=post] [--status=draft] [--force]`);
  process.exit(1);
}

const TEMPLATES: PageTemplate[] = ['landing', 'doc', 'full', 'sidebar', 'post'];
const STATUSES: PageStatus[] = ['draft', 'published', 'unlisted'];
const template = flag('template', 'post');
const status = flag('status', 'draft');
if (!(TEMPLATES as string[]).includes(template)) {
  console.error(`Unknown --template "${template}". Options: ${TEMPLATES.join(', ')}.`);
  process.exit(1);
}
if (!(STATUSES as string[]).includes(status)) {
  console.error(`Unknown --status "${status}". Options: ${STATUSES.join(', ')}.`);
  process.exit(1);
}

// ── Read every .md under --from, keyed by its path relative to the folder. ──
function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries as Array<{ isDirectory(): boolean; isFile(): boolean; name: string }>) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const resolvedFrom = path.resolve(fromDir);
const mdPaths = listMarkdown(resolvedFrom);
if (mdPaths.length === 0) {
  console.error(`${R}No .md files under ${fromDir}.${X}`);
  process.exit(1);
}

const files: Record<string, string> = {};
for (const p of mdPaths) files[path.relative(resolvedFrom, p)] = readFileSync(p, 'utf8');

// ── Map to WebPage facts (pure). ──
const { statements, pages, warnings } = importMarkdownSite(files, {
  section: flag('section', 'blog'),
  template: template as PageTemplate,
  status: status as PageStatus,
});

if (pages === 0) {
  console.error(`${R}0 pages, 0 facts${X} ${D}— every post was skipped (see warnings); nothing written.${X}`);
  for (const w of warnings) console.log(`${Y}!${X} ${w}`);
  process.exit(1);
}

// ── Refuse to clobber an existing output file. ──
if (existsSync(path.resolve(outFile)) && !has('force')) {
  console.error(`${R}Refusing to overwrite ${outFile} (use --force).${X}`);
  process.exit(1);
}

// ── Write the .ttl. ──
const date = new Date().toISOString().slice(0, 10);
const header = `Imported from ${fromDir} on ${date} — ${pages} blog post(s) as WebPage facts (import-markdown-site.ts)`;
writeFileSync(path.resolve(outFile), toTurtle(statements, { header }) + '\n', 'utf8');

console.log(`${G}✓${X} ${pages} pages, ${statements.length} facts ${D}→ ${outFile}${X}`);
for (const w of warnings) console.log(`${Y}!${X} ${w}`);
