/**
 * kb-to-graph-ttl.ts — migrate user-facing "KB" / "knowledge base" → "graph" /
 * "knowledge graph" inside Turtle STRING LITERALS only.
 *
 * The product's noun is "graph". This finishes the terminology migration in the
 * KB content. It runs literals-only (via literalSpans), so IRIs, prefixed names
 * (`kb:`), the `urn:kbase:` namespace, and datatype tags are never touched.
 * Casing is acronym-aware (see src/lib/rdf/terminology.ts). `.svelte` UI strings
 * are handled separately (surgically) — this script is TTL only.
 *
 * Usage:
 *   npx tsx scripts/kb-to-graph-ttl.ts            # apply, print summary
 *   npx tsx scripts/kb-to-graph-ttl.ts --dry-run  # report only
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sweepKbToGraph } from '../src/lib/rdf/terminology';

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
let total = 0;
let changed = 0;

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const { out, count } = sweepKbToGraph(src);
  if (count > 0) {
    changed++;
    total += count;
    console.log(`${DRY_RUN ? 'would fix' : 'fixed'} ${String(count).padStart(3)}  ${relative(ROOT, file)}`);
    if (!DRY_RUN) writeFileSync(file, out);
  }
}

console.log(`\n${DRY_RUN ? '[dry-run] ' : ''}${total} literal replacement(s) across ${changed} file(s) (${files.length} scanned).`);
