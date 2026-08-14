#!/usr/bin/env npx tsx
/**
 * DERIVE CONCEPT-TO-CONCEPT EDGES FROM IMPORTS (F130.2, SCRIPT tier).
 *
 * Matt, 2026-08-14: "shouldn't the code graph have detailed connections for concepts, across
 * multiple files?" It should, and it did not: static/reckons-codebase.ttl carried has-file and
 * tested-by and nothing joining one module to another except skos:broader, which is a
 * containment hierarchy rather than a dependency.
 *
 * oraios/serena (28k stars, MIT) is the same idea done properly — an MCP server exposing
 * LSP-backed symbol tools: find referencing symbols, find declaration, type hierarchy, across
 * 40+ languages. That is the real article, and it is worth saying plainly that this script is
 * not it. But the module-level half needs no language server at all: TypeScript imports are
 * static, and 950 internal import statements across 394 files already state which module
 * depends on which. Deriving that is script tier — deterministic, zero tokens, no new
 * dependency — and it is the edge the estimate work actually needed.
 *
 * WHAT THIS BUYS THE ESTIMATE. src/lib/rdf/scope-derive.ts currently offers a starting number
 * as 30% of a module's file count — a stated convention with nothing behind it. A dependency
 * edge replaces that guess with a computed BLAST RADIUS: change a file, and the graph knows
 * which files import it. That is a measurement rather than a fraction.
 *
 * HONEST LIMITS, and they are the difference between this and Serena:
 *   - FILE granularity, not SYMBOL. "src/lib/rdf/types.ts is imported by 80 files" is true and
 *     coarse; changing one exported type in it does not touch all 80. Only a language server
 *     knows which symbol went where.
 *   - STATIC IMPORTS ONLY. Dynamic `await import(...)` with a computed path is invisible, and
 *     this codebase uses dynamic imports heavily in stores.
 *   - TYPE-ONLY imports count the same as value imports, so the graph over-states coupling.
 *
 * Usage:
 *   npx tsx scripts/offline/derive-code-edges.ts             report
 *   npx tsx scripts/offline/derive-code-edges.ts --write     append edges to the codebase TTL
 *   npx tsx scripts/offline/derive-code-edges.ts --blast=src/lib/rdf/types.ts
 */

import { readFileSync, readdirSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { Parser } from 'n3';

const ROOT = new URL('../..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const BLAST = argv.find((a) => a.startsWith('--blast='))?.split('=')[1];
const CODEBASE = join(ROOT, 'static/reckons-codebase.ttl');
const KPRED = 'urn:kbase:predicate/';

// ── Every source file, and the module that owns it ───────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|\.svelte-kit|\.git/.test(p)) walk(p, out);
    } else if (/\.(ts|svelte|js)$/.test(e.name)) out.push(relative(ROOT, p));
  }
  return out;
}

const files = walk(join(ROOT, 'src'));

const codeQuads = new Parser().parse(readFileSync(CODEBASE, 'utf8'));
const ownerOf = new Map<string, string>();
for (const q of codeQuads) {
  if (q.predicate.value === KPRED + 'has-file') ownerOf.set(q.object.value, q.subject.value);
}
/** Fall back to the module whose declared files share the longest directory prefix. */
const modulePrefixes: Array<{ iri: string; prefix: string }> = [];
{
  const byModule = new Map<string, string[]>();
  for (const [f, m] of ownerOf) byModule.set(m, [...(byModule.get(m) ?? []), f]);
  for (const [iri, fs_] of byModule) {
    const dirs = fs_.map((p) => p.split('/').slice(0, -1).join('/'));
    const common = dirs.reduce((a, b) => {
      let i = 0;
      while (i < a.length && i < b.length && a[i] === b[i]) i++;
      return a.slice(0, i);
    });
    const t = common.replace(/\/$/, '');
    if (t.includes('/')) modulePrefixes.push({ iri, prefix: t });
  }
  modulePrefixes.sort((a, b) => b.prefix.length - a.prefix.length);
}
const moduleFor = (file: string): string | null =>
  ownerOf.get(file) ?? modulePrefixes.find((p) => file.startsWith(p.prefix + '/'))?.iri ?? null;

// ── Resolve imports to repo files ────────────────────────────────────────────

const CANDIDATES = ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js'];

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('$lib')) base = join(ROOT, 'src/lib', spec.slice(4));
  else if (spec.startsWith('$app') || spec.startsWith('$env')) return null;
  else if (spec.startsWith('.')) base = resolve(ROOT, dirname(fromFile), spec);
  else return null; // package import
  for (const ext of CANDIDATES) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return relative(ROOT, p);
  }
  return null;
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

/** file -> files it imports */
const importsOf = new Map<string, Set<string>>();
/** file -> files that import it (the blast radius) */
const importedBy = new Map<string, Set<string>>();

for (const f of files) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const target = resolveImport(f, m[1]);
    if (!target || target === f) continue;
    if (!importsOf.has(f)) importsOf.set(f, new Set());
    importsOf.get(f)!.add(target);
    if (!importedBy.has(target)) importedBy.set(target, new Set());
    importedBy.get(target)!.add(f);
  }
}

// ── Blast radius for one file ────────────────────────────────────────────────

if (BLAST) {
  const direct = [...(importedBy.get(BLAST) ?? [])];
  // Transitive: who depends on the dependents.
  const seen = new Set<string>(direct);
  const queue = [...direct];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const up of importedBy.get(cur) ?? []) if (!seen.has(up)) { seen.add(up); queue.push(up); }
  }
  console.log(`\x1b[1mblast radius\x1b[0m \x1b[2m— ${BLAST}\x1b[0m\n`);
  console.log(`  ${direct.length} file(s) import it directly`);
  console.log(`  ${seen.size} file(s) transitively`);
  const mods = new Set([...seen].map((f) => moduleFor(f)).filter(Boolean) as string[]);
  console.log(`  spanning ${mods.size} module(s): ${[...mods].map((m) => m.replace('urn:reckons:code/', 'code:')).join(', ')}`);
  console.log(
    '\n\x1b[2mFILE granularity, not symbol: changing ONE export in this file does not touch\n' +
      'every dependent. A language server (see oraios/serena) is what narrows this to the\n' +
      'symbols that actually moved.\x1b[0m',
  );
  process.exit(0);
}

// ── Aggregate to module -> module ────────────────────────────────────────────

const moduleEdges = new Map<string, Map<string, number>>();
for (const [from, targets] of importsOf) {
  const mf = moduleFor(from);
  if (!mf) continue;
  for (const t of targets) {
    const mt = moduleFor(t);
    if (!mt || mt === mf) continue;
    if (!moduleEdges.has(mf)) moduleEdges.set(mf, new Map());
    const inner = moduleEdges.get(mf)!;
    inner.set(mt, (inner.get(mt) ?? 0) + 1);
  }
}

const short = (m: string) => m.replace('urn:reckons:code/', 'code:');
const rows: Array<[string, string, number]> = [];
for (const [from, inner] of moduleEdges) for (const [to, n] of inner) rows.push([from, to, n]);
rows.sort((a, b) => b[2] - a[2]);

console.log(
  `\x1b[1mderive code edges\x1b[0m \x1b[2m— ${files.length} files, ` +
    `${[...importsOf.values()].reduce((n, s) => n + s.size, 0)} resolved imports, ` +
    `${rows.length} module->module edge(s)\x1b[0m\n`,
);
for (const [from, to, n] of rows.slice(0, 16)) {
  console.log(`  ${String(n).padStart(4)}  ${short(from).padEnd(20)} -> ${short(to)}`);
}
if (rows.length > 16) console.log(`  \x1b[2m… ${rows.length - 16} more\x1b[0m`);

const mostDepended = [...importedBy.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 5);
console.log('\n\x1b[2mmost depended-upon files (highest blast radius):\x1b[0m');
for (const [f, s] of mostDepended) console.log(`  ${String(s.size).padStart(3)}  ${f}`);

if (!WRITE) {
  console.log('\n\x1b[2mRe-run with --write to append these edges to the codebase graph.\x1b[0m');
  process.exit(0);
}

// Only edges with real weight — a single import between two modules is noise, not structure.
const MIN_WEIGHT = 3;
const kept = rows.filter(([, , n]) => n >= MIN_WEIGHT);
const lines = [
  '',
  '## ── Module dependency edges ─────────────────────────────────────────────────',
  '## DERIVED by scripts/offline/derive-code-edges.ts from static TypeScript imports.',
  `## Re-runnable and idempotent. Edges below ${MIN_WEIGHT} imports are dropped as noise.`,
  '## File granularity, not symbol — see the script header for what that does and does not',
  '## license you to conclude.',
  '',
  ...kept.map(([from, to, n]) => `${short(from)} kpred:depends-on-module ${short(to)} .  # ${n} imports`),
  '',
];
appendFileSync(CODEBASE, lines.join('\n'));
console.log(`\n\x1b[32mappended ${kept.length} edge(s)\x1b[0m \x1b[2m(dropped ${rows.length - kept.length} below weight ${MIN_WEIGHT})\x1b[0m`);
