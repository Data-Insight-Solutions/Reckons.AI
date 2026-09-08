#!/usr/bin/env npx tsx
/**
 * Docs graph registration check (F27) — every publishable docs graph, in every list that
 * must know about it.
 *
 * SCRIPT TIER: deterministic, zero tokens, no model. It answers a question with a rule —
 * "is this file named in that list" — which is the cheapest tier that can be right, and the
 * ladder in CLAUDE.md says such a check must not be left to a model or to a person's memory.
 *
 * WHY IT EXISTS — a real incident, twice.
 *
 * `static/docs-user-paths.ttl` was written on 2026-09-04 and registered in `SOURCES` in
 * `scripts/docs-pages.ts` and NOWHERE ELSE. The first consequence is already in HANDOFF.md:
 * before it reached even that one list, five journeys generated zero pages for two days and
 * nothing reported it. The second was still live on 2026-09-08 and is worse:
 *
 *   - `static/website.ttl` (the composed information architecture) had no dataset for it,
 *     so no composed page claimed its entities;
 *   - `CORPUS` in `scripts/docs-compose.ts` did not load it, so `npm run docs:compose` would
 *     have PRUNED its 21 published pages and composed nothing to replace them;
 *   - `CORPUS` in `scripts/offline/docs-consolidate.ts` did not load it either — so the gate
 *     that exists precisely to report what consolidation would drop could not see the thing
 *     being dropped, and printed "every entity is claimed by a page — nothing would be
 *     dropped" in green.
 *
 * A gate blind in the same place as the tool it guards is not a gate. The specific missing
 * entries are fixed; this check is the part that stops it happening to the next graph, because
 * four hand-maintained lists of the same thing will drift again — that is what they do.
 *
 * Usage: npx tsx scripts/offline/docs-graph-registration.ts [--quiet]
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

/**
 * Graphs that are deliberately NOT publishing sources, and why.
 *
 * Stated here rather than filtered silently: an unexplained exemption is how the next graph
 * gets quietly added to this list instead of to the four registries.
 */
export const EXEMPT: Record<string, string> = {
  'docs-all.ttl':
    'Standalone importable hub — an overview graph with KB Leap nodes to the sub-graphs, '
    + 'referenced by no generator. starter-guide.ttl is what the site publishes as the Guide.',
};

interface Registry {
  /** How it is named in a failure message. */
  label: string;
  file: string;
  /** The registry's contents, as the set of graph filenames it names. */
  read: (text: string) => Set<string>;
}

/**
 * Filenames inside the first array literal assigned to `name`.
 *
 * Deliberately narrow: it reads the array literal rather than the whole file, so a graph
 * mentioned only in a comment or a doc-string does not count as registered. That distinction is
 * the entire point — `docs-user-paths.ttl` appeared in prose in more than one of these files
 * while being absent from the list that actually drives the code.
 */
export function arrayLiteralEntries(text: string, name: string): Set<string> {
  const start = text.indexOf(`const ${name}`);
  if (start === -1) return new Set();
  const open = text.indexOf('[', start);
  const close = text.indexOf('];', open);
  if (open === -1 || close === -1) return new Set();
  const body = text.slice(open, close);
  return new Set([...body.matchAll(/['"]([\w.-]+\.ttl)['"]/g)].map((m) => m[1]));
}

export const REGISTRIES: Registry[] = [
  {
    label: 'SOURCES in scripts/docs-pages.ts (per-entity generator)',
    file: 'scripts/docs-pages.ts',
    // SOURCES is an array of objects, not of strings, so match the `file:` fields.
    read: (t) => {
      const start = t.indexOf('const SOURCES');
      const close = t.indexOf('];', start);
      if (start === -1 || close === -1) return new Set();
      const body = t.slice(start, close);
      return new Set([...body.matchAll(/file:\s*['"]([\w.-]+\.ttl)['"]/g)].map((m) => m[1]));
    },
  },
  {
    label: 'CORPUS in scripts/docs-compose.ts (composed generator)',
    file: 'scripts/docs-compose.ts',
    read: (t) => arrayLiteralEntries(t, 'CORPUS'),
  },
  {
    label: 'CORPUS in scripts/offline/docs-consolidate.ts (the orphan gate)',
    file: 'scripts/offline/docs-consolidate.ts',
    read: (t) => arrayLiteralEntries(t, 'CORPUS'),
  },
  {
    label: 'a void:Dataset in static/website.ttl (the composed architecture)',
    file: 'static/website.ttl',
    // dcterms:source is what resolves a dataset to a file; a dataset without one is already
    // reported by readWebsiteGraph, so matching it here needs no parser.
    read: (t) => new Set([...t.matchAll(/dcterms:source\s+"([\w.-]+\.ttl)"/g)].map((m) => m[1])),
  },
];

function main(): void {
  const quiet = process.argv.includes('--quiet');

  const graphs = readdirSync(STATIC_DIR)
    .filter((f) => (f.startsWith('docs-') || f === 'starter-guide.ttl') && f.endsWith('.ttl'))
    .filter((f) => !(f in EXEMPT))
    .sort();

  const registered = REGISTRIES.map((r) => ({
    registry: r,
    entries: r.read(readFileSync(join(ROOT, r.file), 'utf8')),
  }));

  // A registry that parsed to nothing means this check silently stopped checking — the exact
  // failure it exists to catch, one level up. Fail loudly rather than reporting all-clear.
  const emptyRegistries = registered.filter((r) => r.entries.size === 0);

  const missing: Array<{ graph: string; where: string[] }> = [];
  for (const graph of graphs) {
    const where = registered.filter((r) => !r.entries.has(graph)).map((r) => r.registry.label);
    if (where.length > 0) missing.push({ graph, where });
  }

  console.log('');
  console.log(C.bold('docs graph registration') + C.dim(` — ${graphs.length} publishable graphs × ${REGISTRIES.length} registries`));

  if (!quiet) {
    for (const [file, why] of Object.entries(EXEMPT)) {
      console.log(C.dim(`  exempt: ${file} — ${why}`));
    }
  }

  if (emptyRegistries.length > 0) {
    for (const r of emptyRegistries) {
      console.log(C.red(`  READ FAILED: ${r.registry.label} parsed to zero graphs — this check is not checking.`));
    }
    process.exit(1);
  }

  if (missing.length === 0) {
    console.log(C.green(`  every docs graph is registered in all ${REGISTRIES.length} lists.`));
    return;
  }

  console.log('');
  for (const m of missing) {
    console.log(C.red(`  ${C.bold(m.graph)} is not registered in:`));
    for (const w of m.where) console.log(C.red(`    - ${w}`));
  }
  console.log('');
  console.log(C.red(`  ${missing.length} graph(s) partially registered. A graph in some lists and not others `
    + `publishes inconsistently, and the gate goes blind in the same place the generator does.`));
  process.exit(1);
}

// Guarded so a test can import the pure parts without running the check as a side effect.
if (process.argv[1] && process.argv[1].endsWith('docs-graph-registration.ts')) main();
