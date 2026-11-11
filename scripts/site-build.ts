#!/usr/bin/env npx tsx
/**
 * site:build (F274.4.1) — a site repository's content/ into static HTML with the Reckons.AI engine.
 *
 *   npm run site:build -- --site=path/to/site-repo --out=dist [--title="My Site"] [--drafts]
 *     [--config-override=<json file>]
 *
 * --config-override merges the top-level keys of a JSON file over site.config.json at build time (shallow;
 * `webhook` is shorthand for contact.webhook). Keep a private address in such a file outside the repository.
 *
 * --drafts is LOCAL PREVIEW ONLY: draft pages are built with a visible "Draft" marker and a noindex
 * meta; the output is stamped so no deploy path accepts it, and this command refuses --drafts in CI.
 *
 * content/*.md goes through site-import into WebPage triples and is rendered by the
 * existing static generator; assets/ and admin/ are copied byte-for-byte; _headers is
 * written with the project's Cloudflare Pages hardening; the result is swapped into
 * --out atomically (a fresh directory, or a previous site:build output of the same shape).
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSite } from '../src/lib/publish/site-build.js';

const USAGE = 'Usage: npm run site:build -- --site=<site repository> --out=<dir> [--title=<site title>] [--drafts] [--config-override=<json file>]';
const MISSING = 'site:build: --site=<site repository> and --out=<output directory> are required';
const NOTFOUND = 'site:build: site directory not found: ';

const flag = (name: string): string | undefined => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.split('=').slice(1).join('=') : undefined;
};

if (process.argv.includes('--help')) {
  console.log(USAGE);
  process.exit(0);
}

const site = flag('site');
const out = flag('out');
const title = flag('title');
const drafts = process.argv.includes('--drafts');

if (drafts && (process.env.CI || process.env.GITHUB_ACTIONS)) {
  console.error('site:build: --drafts is local preview only and is refused in CI');
  process.exit(1);
}

if (!site || !out) {
  console.error(MISSING);
  console.error(USAGE);
  process.exit(1);
}

const siteDir = resolve(site);
if (!existsSync(siteDir) || !statSync(siteDir).isDirectory()) {
  console.error(NOTFOUND + siteDir);
  process.exit(1);
}

try {
  const result = buildSite({ site: siteDir, out: resolve(out), siteTitle: title || undefined, includeDrafts: drafts, configOverride: flag('config-override') });
  if (drafts) console.log('site:build: DRAFT PREVIEW (drafts included, noindex, not deployable) - ' + result.out);
  console.log('site:build: ' + result.pageCount + ' page(s) built into ' + result.out);
  console.log('  ' + result.files.length + ' files total; assets copied: ' + result.copiedAssets + ', admin copied: ' + result.copiedAdmin);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
