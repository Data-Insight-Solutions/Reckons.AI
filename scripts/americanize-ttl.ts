/**
 * americanize-ttl.ts — deterministic British → American spelling sweep for the
 * TTL knowledge bases.
 *
 * Product copy reads consistently in American English (per the `american-spelling`
 * decision). This rewrites British spellings inside Turtle STRING LITERALS only
 * — rdfs:label, rdfs:comment, descriptions, etc. It never touches IRIs, prefixed
 * names (`kb:EntityNormalisation`), `@prefix` lines, or datatype/lang tags, so it
 * can't rename an entity and break a cross-reference. Entity identifiers that
 * carry a British spelling are REPORTED for manual review, not changed.
 *
 * The spelling map + rewrite logic live in src/lib/rdf/americanize.ts (pure,
 * unit-tested); this script is just the file walk + CLI.
 *
 * Usage:
 *   npx tsx scripts/americanize-ttl.ts            # apply, print summary
 *   npx tsx scripts/americanize-ttl.ts --dry-run  # report only, write nothing
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sweepLiterals, scanIdentifiers } from '../src/lib/rdf/americanize';

const ROOT = process.cwd();
const SEARCH_DIRS = ['static', 'reckons-workspace/kbs'];
const DRY_RUN = process.argv.includes('--dry-run');

function walkTtl(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTtl(full, acc);
    else if (name.endsWith('.ttl')) acc.push(full);
  }
  return acc;
}

const files = SEARCH_DIRS.flatMap((d) => walkTtl(join(ROOT, d)));
let totalChanges = 0;
let changedFiles = 0;
const idReport: { file: string; ids: string[] }[] = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const { out, count } = sweepLiterals(src);
  const ids = scanIdentifiers(src);
  if (ids.length) idReport.push({ file: relative(ROOT, file), ids });

  if (count > 0) {
    changedFiles++;
    totalChanges += count;
    console.log(`${DRY_RUN ? 'would fix' : 'fixed'} ${String(count).padStart(3)}  ${relative(ROOT, file)}`);
    if (!DRY_RUN) writeFileSync(file, out);
  }
}

console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}${totalChanges} literal replacement(s) across ${changedFiles} file(s) (${files.length} scanned).`);

if (idReport.length) {
  console.log(`\n⚠ Manual review — entity identifiers with British spelling (NOT changed; renaming breaks cross-refs):`);
  for (const { file, ids } of idReport) {
    console.log(`  ${file}`);
    for (const id of ids) console.log(`    ${id}`);
  }
}
