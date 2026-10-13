#!/usr/bin/env npx tsx
/**
 * CODEBASE COVERAGE (script tier) — how much of the code the graphs actually describe, and a
 * ratchet so it cannot get worse. Matt, 2026-10-07: "improve any internal codebase to graph
 * alignment checks and other maintenance jobs".
 *
 * WHY. The project's notes said kpred:has-file covered 100% of git-tracked files. Measured
 * 2026-10-07: 589 of 966 tracked code files (61%) were named by any kpred:has-file or
 * kpred:tested-by. graph-lint checks that every path the graph NAMES exists, which is why links
 * never rot; nothing required a NEW file to be named, which is why coverage quietly fell.
 *
 *   report         coverage by area, and every unlinked file classified by what its folder says:
 *                    sibling  every linked file in the same folder belongs to ONE code: module;
 *                    several  linked siblings belong to more than one module (a judgment);
 *                    none     no linked sibling (likely a missing module, a modelling decision).
 *   --check        the RATCHET (blocking, CI): the unlinked count may fall, never rise. Baseline:
 *                  `kpred:coverage-ratchet "unlinked/<n>"` on code:repo in static/reckons-codebase.ttl.
 *   --apply        link every `sibling` file to its folder's module in reckons-codebase.ttl.
 *                  A heuristic, so it writes a DIFF for review, never a confirmed fact by itself:
 *                  the pull request is the human gate.
 *
 * Usage: npx tsx scripts/offline/codebase-coverage.ts [--check | --apply] [--list]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Parser } from 'n3';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const CODEBASE = 'static/reckons-codebase.ttl';
const KPRED = 'urn:kbase:predicate/';
const CODE = 'urn:reckons:code/';

/** What counts as code to describe. Vendored assets under static/ and generated content/ do not. */
export const isCode = (f: string): boolean => /\.(ts|svelte|js|mjs|sh)$/.test(f) && !/^(content|static)\//.test(f) && !f.endsWith('.d.ts');

export type Links = { owner: Map<string, string>; linked: Set<string> };

/** Every has-file / tested-by object across the given graphs; owner = the first code: subject. */
export function readLinks(graphs: { path: string; ttl: string }[]): Links {
  const owner = new Map<string, string>();
  const linked = new Set<string>();
  for (const g of graphs) {
    let quads;
    try { quads = new Parser({ format: 'Turtle' }).parse(g.ttl); } catch { continue; } // graph-lint owns parse errors
    for (const q of quads) {
      if (q.predicate.value !== `${KPRED}has-file` && q.predicate.value !== `${KPRED}tested-by`) continue;
      linked.add(q.object.value);
      if (q.subject.value.startsWith(CODE) && !owner.has(q.object.value)) owner.set(q.object.value, q.subject.value);
    }
  }
  return { owner, linked };
}

export type Unlinked =
  | { file: string; kind: 'sibling'; module: string }
  | { file: string; kind: 'several'; modules: string[] }
  | { file: string; kind: 'weak'; module: string }
  | { file: string; kind: 'none' };

/**
 * How strong the evidence must be before a module claims an unlinked file. Two rules, both learned
 * on the first runs (2026-10-07):
 *   TEST NAME   a test X.test.ts (or X.spec.ts) belongs to the module that owns X.ts or X.svelte
 *               in the parent folder. The strongest evidence there is.
 *   FOLDER      otherwise, the folder's single owning module claims it only if it owns at least
 *               MIN_OWNED files there AND at least MIN_AFFINITY of the module's own files live in
 *               that folder. The bare "one module in the folder" rule sent 78 offline jobs to
 *               code:local-security-audits, a TOPIC module whose two files happened to sit there;
 *               a share-of-folder rule then wrongly rejected code:rdf for the large rdf folder.
 *               Affinity asks the right question: is this module ABOUT this folder?
 */
const dirOf = (f: string) => f.slice(0, Math.max(0, f.lastIndexOf('/')));
/** A module's tests live in X/__tests__; for ownership they belong to X (code:rdf was 26/44 without this). */
const folderOf = (f: string) => dirOf(f).replace(/\/__tests__$/, '');

export const MIN_OWNED = 3;
export const MIN_AFFINITY = 0.6;

/** Pure: classify each unlinked code file by the evidence for its module. */
export function classify(code: string[], links: Links): Unlinked[] {
  const ownedIn = new Map<string, Map<string, number>>(); // dir -> module -> count
  const ownedTotal = new Map<string, number>(); // module -> count, any folder
  for (const f of code) {
    const o = links.owner.get(f);
    if (!o) continue;
    const d = folderOf(f);
    if (!ownedIn.has(d)) ownedIn.set(d, new Map());
    ownedIn.get(d)!.set(o, (ownedIn.get(d)!.get(o) ?? 0) + 1);
    ownedTotal.set(o, (ownedTotal.get(o) ?? 0) + 1);
  }
  const codeSet = new Set(code);
  return code.filter((f) => !links.linked.has(f)).map((file): Unlinked => {
    // TEST NAME: src/lib/rdf/__tests__/diff.test.ts -> src/lib/rdf/diff.ts
    const t = file.match(/^(.*?)\/__tests__\/(.+?)\.(?:test|spec)\.ts$/);
    if (t) {
      for (const ext of ['.ts', '.svelte.ts', '.svelte']) {
        const src = `${t[1]}/${t[2]}${ext}`;
        const o = codeSet.has(src) ? links.owner.get(src) : undefined;
        if (o) return { file, kind: 'sibling', module: o };
      }
    }
    const d = folderOf(file);
    const mods = [...(ownedIn.get(d) ?? new Map())].sort((a, b) => a[0].localeCompare(b[0]));
    if (mods.length > 1) return { file, kind: 'several', modules: mods.map(([m]) => m) };
    if (mods.length === 0) return { file, kind: 'none' };
    const [module, owned] = mods[0];
    const strong = owned >= MIN_OWNED && owned / (ownedTotal.get(module) ?? owned) >= MIN_AFFINITY;
    return strong ? { file, kind: 'sibling', module } : { file, kind: 'weak', module };
  });
}

/** Read `kpred:coverage-ratchet "unlinked/<n>"`; null when absent or malformed. */
export function readCoverageRatchet(ttl: string): number | null {
  const m = ttl.match(/kpred:coverage-ratchet\s+"unlinked\/(\d+)"/);
  return m ? Number(m[1]) : null;
}

/**
 * Pure: add `kpred:has-file "<path>" ;` lines to a module's block, after its last existing
 * has-file line, in path order. A module with no has-file line in this text is skipped and
 * reported: the edit never invents a block or guesses where one ends.
 */
export function insertHasFiles(ttl: string, moduleLocal: string, paths: string[]): { ttl: string; inserted: number } {
  const lines = ttl.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^code:${moduleLocal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+rdf:type\\b`).test(l));
  if (start < 0) return { ttl, inserted: 0 };
  let end = start;
  while (end < lines.length && !/\.\s*$/.test(lines[end].replace(/"(?:[^"\\]|\\.)*"/g, '""'))) end++;
  let last = -1;
  for (let i = start; i <= end && i < lines.length; i++) if (/kpred:has-file\s+"/.test(lines[i])) last = i;
  if (last < 0) return { ttl, inserted: 0 };
  const indent = lines[last].match(/^\s*/)![0];
  const fresh = [...paths].sort().map((p) => `${indent}kpred:has-file "${p}" ;`);
  // When the last has-file line also ENDS the block, the terminator moves to the last new line;
  // inserting after a ' .' would put the new links outside the block (the first --apply did this,
  // and the parse check refused to write it).
  if (/\.\s*$/.test(lines[last])) {
    lines[last] = lines[last].replace(/\s*\.\s*$/, ' ;');
    fresh[fresh.length - 1] = fresh[fresh.length - 1].replace(/ ;$/, ' .');
  }
  lines.splice(last + 1, 0, ...fresh);
  return { ttl: lines.join('\n'), inserted: fresh.length };
}

function main(): void {
  const argv = process.argv.slice(2);
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const graphs = tracked.filter((f) => /^static\/.*\.ttl$/.test(f)).map((path) => ({ path, ttl: readFileSync(join(ROOT, path), 'utf8') }));
  const code = tracked.filter(isCode);
  const links = readLinks(graphs);
  const unlinked = classify(code, links);
  const count = (k: Unlinked['kind']) => unlinked.filter((u) => u.kind === k).length;
  const pct = Math.round(((code.length - unlinked.length) / code.length) * 100);
  console.log(`codebase coverage: ${code.length - unlinked.length} of ${code.length} code files named by a graph (${pct}%); unlinked ${unlinked.length}: sibling ${count('sibling')} · weak ${count('weak')} · several ${count('several')} · none ${count('none')}`);

  if (argv.includes('--list')) for (const u of unlinked) console.log(`  ${u.kind.padEnd(7)} ${u.file}${u.kind === 'sibling' ? `  → ${u.module.slice(CODE.length)}` : u.kind === 'weak' ? `  ~ ${u.module.slice(CODE.length)}?` : u.kind === 'several' ? `  ? ${u.modules.map((m) => m.slice(CODE.length)).join(' | ')}` : ''}`);

  if (argv.includes('--check')) {
    const max = readCoverageRatchet(readFileSync(join(ROOT, CODEBASE), 'utf8'));
    if (max === null) { console.error(`✗ no kpred:coverage-ratchet "unlinked/<n>" in ${CODEBASE}: nothing is enforced.`); process.exit(1); }
    if (unlinked.length > max) {
      // Name the files this branch added, which is what the author can act on.
      let added: string[] = [];
      try { added = execFileSync('git', ['diff', '--name-only', '--diff-filter=A', 'origin/dev...HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n'); } catch { /* no origin/dev here */ }
      const fresh = unlinked.filter((u) => added.includes(u.file));
      console.error(`✗ ${unlinked.length} unlinked code files, baseline ${max}: ${unlinked.length - max} new. Name each new file with kpred:has-file on its module in ${CODEBASE}.`);
      for (const u of (fresh.length ? fresh : unlinked.slice(0, 20))) console.error(`    ${u.file}${u.kind === 'sibling' ? `  (its folder belongs to ${u.module.slice(CODE.length)})` : ''}`);
      process.exit(1);
    }
    console.log(unlinked.length < max ? `! ${unlinked.length} unlinked, baseline ${max}: lower the baseline to lock the improvement in.` : `✓ at baseline (${max}).`);
  }

  if (argv.includes('--apply')) {
    let ttl = readFileSync(join(ROOT, CODEBASE), 'utf8');
    const byModule = new Map<string, string[]>();
    for (const u of unlinked) if (u.kind === 'sibling') byModule.set(u.module, [...(byModule.get(u.module) ?? []), u.file]);
    let total = 0;
    const skipped: string[] = [];
    for (const [module, paths] of byModule) {
      const r = insertHasFiles(ttl, module.slice(CODE.length), paths);
      if (r.inserted === 0) skipped.push(module.slice(CODE.length));
      ttl = r.ttl; total += r.inserted;
    }
    new Parser({ format: 'Turtle' }).parse(ttl); // never write a graph that does not parse
    writeFileSync(join(ROOT, CODEBASE), ttl);
    console.log(`applied: ${total} has-file links added to ${CODEBASE}${skipped.length ? `; skipped (module block not in this file): ${skipped.join(', ')}` : ''}`);
  }
}

if (process.argv[1] && process.argv[1].endsWith('codebase-coverage.ts')) main();
