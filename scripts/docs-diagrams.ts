#!/usr/bin/env npx tsx
/**
 * Render every mermaid diagram declared in the docs graphs into the committed cache.
 *
 * THE SPLIT THIS ENFORCES. `scripts/docs-pages.ts` never renders — it looks diagrams up by hash
 * and fails loudly on a miss. This script is the only thing that runs a browser. So the expensive,
 * machine-dependent step happens once, deliberately, on a developer's machine, and its result is
 * reviewed in a PR like any other artifact; CI and the docs build only ever read it.
 *
 * The reason is determinism, not speed. Mermaid lays text out using the fonts installed on the box
 * doing the rendering, so a CI runner and a laptop produce different SVG for identical input. If
 * CI re-rendered, `md-align` and the regeneration check would report a diff nobody wrote.
 *
 * Usage:
 *   npx tsx scripts/docs-diagrams.ts             render anything missing from the cache
 *   npx tsx scripts/docs-diagrams.ts --check     report missing entries, render nothing (CI)
 *   npx tsx scripts/docs-diagrams.ts --prune     also drop entries no graph refers to any more
 *   npx tsx scripts/docs-diagrams.ts --force     re-render everything (after a contract bump)
 */
import { readFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { Parser, type Quad } from 'n3';
import {
  loadCache, saveCache, diagramKey, renderDiagrams, CACHE_FILE,
} from './lib/mermaid-render.js';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const STATIC_DIR = join(ROOT, 'static');

/** The predicate a docs graph uses to attach a diagram to an entity. */
export const DIAGRAM_PREDICATE = 'urn:kbase:predicate/diagram';

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const PRUNE = argv.includes('--prune');
const FORCE = argv.includes('--force');

/** Every TTL in static/ is scanned — a diagram is worth rendering wherever it is declared. */
function ttlFiles(): string[] {
  return readdirSync(STATIC_DIR)
    .filter((f: string) => f.endsWith('.ttl'))
    .sort()
    .map((f: string) => join(STATIC_DIR, f));
}

/** Collect every distinct mermaid source declared across the graphs. */
export function collectDiagramSources(files: string[]): string[] {
  const seen = new Set<string>();
  for (const file of files) {
    let quads: Quad[];
    try {
      quads = new Parser().parse(readFileSync(file, 'utf8')) as Quad[];
    } catch {
      // A TTL that does not parse is graph-lint's problem to report, not this script's to crash on.
      continue;
    }
    for (const q of quads) {
      if (q.predicate.value !== DIAGRAM_PREDICATE) continue;
      if (q.object.termType !== 'Literal') continue;
      const src = q.object.value.trim();
      if (src) seen.add(src);
    }
  }
  return [...seen].sort();
}

async function main(): Promise<void> {
  const files = ttlFiles();
  const sources = collectDiagramSources(files);
  const cache = loadCache();

  const wanted = new Map(sources.map((s) => [diagramKey(s), s]));
  const missing = FORCE ? [...wanted.values()] : [...wanted].filter(([k]) => !cache[k]).map(([, s]) => s);
  const orphans = Object.keys(cache).filter((k) => !wanted.has(k));

  console.log(`${sources.length} diagram(s) declared across ${files.length} graph file(s).`);

  if (CHECK) {
    if (missing.length) {
      console.error(`\n✗ ${missing.length} diagram(s) are not in the cache. Run: npm run docs:diagrams\n`);
      for (const s of missing) console.error(`  ${diagramKey(s)}  ${s.split('\n')[0].slice(0, 70)}…`);
      process.exit(1);
    }
    console.log(`✓ every declared diagram is cached${orphans.length ? ` (${orphans.length} orphan entr(y/ies) — run --prune)` : ''}.`);
    return;
  }

  if (missing.length) {
    console.log(`Rendering ${missing.length} diagram(s) — launching Chromium…`);
    const rendered = await renderDiagrams(missing);
    for (const [k, svg] of rendered) cache[k] = svg;
    console.log(`✓ rendered ${rendered.size}.`);
  } else {
    console.log('✓ nothing to render — every diagram is already cached.');
  }

  if (PRUNE && orphans.length) {
    for (const k of orphans) delete cache[k];
    console.log(`✓ pruned ${orphans.length} orphaned entr(y/ies).`);
  } else if (orphans.length) {
    console.log(`  ${orphans.length} cached diagram(s) are no longer declared — run --prune to drop them.`);
  }

  saveCache(cache);
  console.log(`Cache written: ${CACHE_FILE.replace(ROOT + '/', '')}`);
}

// Guarded so importing this module in a test never launches a browser.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
