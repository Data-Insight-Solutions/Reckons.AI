#!/usr/bin/env npx tsx
/**
 * ANCHOR RESOLUTION (F122.1.2, script tier) — every stored anchor must point at a chunk that is in
 * the same file. A fact that cites a passage which is not there is a citation that cannot be opened,
 * and "an anchor that does not resolve is shown as unresolved, never dropped and never guessed"
 * (kb:evidence-chain) only works if something finds them.
 *
 * Reads every .ttl under static/, reckons-workspace/kbs and mcp-workspace/kbs (or the paths given),
 * imports it with the app's own importer, and runs unresolvedAnchors. Files with no anchors cost one
 * parse and report nothing. Exit 1 when any anchor does not resolve, or any anchor was malformed.
 *
 * Usage: npx tsx scripts/offline/anchor-resolution.ts [file.ttl ...] [--quiet]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { importTurtleFull } from '../../src/lib/rdf/import-ttl.js';
import { unresolvedAnchors } from '../../src/lib/ingest/anchor-resolution.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const QUIET = process.argv.includes('--quiet');
const given = process.argv.slice(2).filter((a) => !a.startsWith('--'));

function ttlIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? ttlIn(join(dir, e.name)) : e.name.endsWith('.ttl') ? [join(dir, e.name)] : []));
}

const files = given.length > 0 ? given.map((f) => resolve(f)) : [join(ROOT, 'static'), join(ROOT, 'reckons-workspace/kbs'), join(ROOT, 'mcp-workspace/kbs')].flatMap(ttlIn);
let anchored = 0;
let bad = 0;
for (const f of files) {
  const text = readFileSync(f, 'utf8');
  if (!text.includes('oa#hasTarget')) continue; // no anchors possible; skip the parse
  try {
    const r = await importTurtleFull(text, { name: f });
    const withAnchor = r.statements.filter((s) => s.anchor).length;
    anchored += withAnchor;
    const problems = unresolvedAnchors(r.statements, r.chunks);
    for (const p of problems) { bad++; console.log(`  ✗ ${f.replace(ROOT + '/', '')}: ${p.statementId} -> ${p.chunk} (${p.reason})`); }
    for (const p of r.anchorProblems ?? []) { bad++; console.log(`  ✗ ${f.replace(ROOT + '/', '')}: malformed anchor on ${p.statement} (${p.reason})`); }
  } catch (e) {
    bad++;
    console.log(`  ✗ ${f.replace(ROOT + '/', '')}: does not import (${e instanceof Error ? e.message : e})`);
  }
}
if (!QUIET || bad > 0) console.log(`anchor-resolution: ${files.length} file(s) read, ${anchored} anchor(s) found, ${bad} problem(s).`);
process.exit(bad > 0 ? 1 : 0);
