#!/usr/bin/env npx tsx
/**
 * THE OTHER HALF OF THE TRIGGER (F189) — script tier, no model, writes nothing.
 *
 * Matt, 2026-09-09: "I am not sure the trigger mechanism for graph change, if it exists, so maybe
 * we need more of a polling loop."
 *
 * It half exists, and this is the missing half. `docs-edits.ts` watches the PAGE -> GRAPH
 * direction: somebody edited a published page, propose it back onto the entity that owns the
 * sentence. The GRAPH -> PAGE direction was written on 2026-09-08 (`findStale` in
 * scripts/lib/page-provenance.ts, with tests) and then called from nowhere but its own test file.
 *
 * AND MATT IS RIGHT THAT POLLING IS THE MODEL. There is nothing to subscribe to: the graph is a
 * set of files in git, so a "trigger" here can only ever be a check that runs. That makes this a
 * job in the sweep rather than a daemon — cheaper, and it cannot drift out of sync with a build
 * the way a listening process can.
 *
 * WHAT IT REPORTS, and the second one is the interesting one:
 *
 *   STALE     a page whose substantive facts moved since it was generated. Regenerate.
 *   SILENT    a substantive fact moved and the page did NOT change. That is either a page failing
 *             to surface something it should, or provenance pointing at the wrong entity — and
 *             both are invisible today. This is the check that has no other way of being made.
 *
 * "Substantive" is fact altitude, not a list of important predicates: a status change is a
 * judgment and moves the hash; a timestamp is a log and does not. See page-provenance.ts.
 *
 * Usage: npx tsx scripts/offline/docs-staleness.ts [--quiet]
 */

import { Parser, type Quad } from 'n3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { findStale, hashFacts, DEFAULT_FLOOR, type ProvQuad, type PageProvenance } from '../lib/page-provenance.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');
const CONTENT = join(ROOT, 'content');
const PROVENANCE = join(ROOT, 'static', 'page-provenance.json');
const QUIET = process.argv.includes('--quiet');

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

interface Prov extends PageProvenance { pageHash?: string }

/** A hash of the page's own bytes, so "the facts moved but the page did not" is answerable. */
function pageHash(path: string): string | null {
  const file = join(CONTENT, `${path}.md`);
  if (!existsSync(file)) return null;
  return createHash('sha256').update(readFileSync(file, 'utf8')).digest('hex').slice(0, 16);
}

function main(): void {
  if (!existsSync(PROVENANCE)) {
    console.error(C.red('No static/page-provenance.json. Run: npm run docs:build'));
    process.exit(1);
  }
  const { pages } = JSON.parse(readFileSync(PROVENANCE, 'utf8')) as { pages: Prov[] };

  const quadsByGraph = new Map<string, ProvQuad[]>();
  for (const p of pages) {
    if (quadsByGraph.has(p.graph)) continue;
    const file = join(STATIC_DIR, p.graph);
    if (!existsSync(file)) { quadsByGraph.set(p.graph, []); continue; }
    let quads: Quad[];
    try { quads = new Parser().parse(readFileSync(file, 'utf8')); } catch { quads = []; }
    quadsByGraph.set(p.graph, quads.map((q) => ({
      subject: { value: q.subject.value },
      predicate: { value: q.predicate.value },
      object: { value: q.object.value, termType: q.object.termType },
    })));
  }

  const stale = findStale(pages, quadsByGraph, DEFAULT_FLOOR);

  /*
   * SILENT pages: the facts moved AND the file on disk is byte-identical to what it was when the
   * provenance was written. A page whose facts changed should look different; one that does not is
   * making a claim it no longer supports, or the provenance points at the wrong entity.
   *
   * Only computable where the recorded provenance carried a page hash. Older entries did not, and
   * saying so is better than treating "no baseline" as "unchanged".
   */
  const silent = stale.filter((s) => {
    const p = pages.find((x) => x.path === s.path) as Prov | undefined;
    return p?.pageHash !== undefined && p.pageHash === pageHash(s.path);
  });
  const noBaseline = pages.filter((p) => p.pageHash === undefined).length;

  console.log('');
  console.log(C.bold('docs staleness') + C.dim(` — ${pages.length} pages, floor: ${DEFAULT_FLOOR}`));

  if (stale.length === 0) {
    console.log(C.green('  every page still matches the substantive facts it was built from.'));
  } else {
    for (const s of stale) {
      const tag = s.reason === 'entity-gone' ? C.red('ENTITY GONE') : C.yellow('facts moved');
      console.log(`  ${tag}  ${C.cyan(s.path)}`);
      if (!QUIET) {
        console.log(C.dim(`      ${s.entity}  ${s.factCount} -> ${s.currentCount} substantive fact(s)`));
      }
    }
    console.log('');
    console.log(C.dim(`  ${stale.length} page(s) to regenerate: npm run docs:build`));
  }

  if (silent.length > 0) {
    console.log('');
    console.log(C.red(C.bold(`  ${silent.length} SILENT page(s) — facts moved and the page did not:`)));
    for (const s of silent) console.log(C.red(`    ${s.path}`));
    console.log(C.dim('    Either the page does not surface what changed, or its provenance names the'));
    console.log(C.dim('    wrong entity. Both are invisible without this check.'));
  }
  if (noBaseline > 0 && !QUIET) {
    console.log(C.dim(`\n  ${noBaseline} page(s) carry no page hash, so SILENT cannot be computed for them.`));
    console.log(C.dim('  Re-run npm run docs:build to record one. No baseline is not the same as unchanged.'));
  }
}

if (process.argv[1] && process.argv[1].endsWith('docs-staleness.ts')) main();
