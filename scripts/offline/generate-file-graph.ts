#!/usr/bin/env npx tsx
/**
 * GENERATE THE FILE-GRANULAR CODE GRAPH (F130.5, SCRIPT tier).
 *
 * Matt, 2026-08-14: "I think we need that file granularity, in the code graph, to achieve a
 * clear scope estimate."
 *
 * THE BLOCKER WAS THE DATA MODEL, not the analysis. static/reckons-codebase.ttl records files
 * as LITERALS — `code:rdf kpred:has-file "src/lib/rdf/types.ts"` — and nothing can be said
 * about a literal. No file-to-file edge, no per-file blast radius inside the graph, and no way
 * for a design to name the specific files it will touch. So an estimate could only ever be
 * "somewhere between 1 and the 24 files in code:rdf", which is a range, not an estimate.
 *
 * Promoting files to ENTITIES fixes that: a file gets an IRI, a type, its module, and real
 * kpred:imports edges to other files. A design can then say kpred:touches-file, and the
 * estimate becomes NAMED FILES PLUS THEIR BLAST RADIUS — computed, not apportioned.
 *
 * WRITTEN TO ITS OWN GRAPH, deliberately. This output is 100% derived and regenerated wholesale;
 * reckons-codebase.ttl is hand-maintained and human-readable. Mixing generated content into a
 * hand-authored file is what makes regeneration destructive, so they stay apart and the
 * module map remains something a person can read.
 *
 * FULL IRIs, NOT SLUGS. `<urn:reckons:file/src/lib/rdf/types.ts>` keeps the path intact and
 * reversible; a prefixed slug (file:src-lib-rdf-types-ts) would be shorter and lossy, and the
 * path is the identifier that every other tool in this repo already speaks.
 *
 * Usage: npx tsx scripts/offline/generate-file-graph.ts [--check]
 *   --check  exit 1 if the graph is stale (for CI), writing nothing
 */

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve, relative, basename } from 'node:path';
import { Parser } from 'n3';
import { readTextOr } from '../lib/read-file.js';

const ROOT = new URL('../..', import.meta.url).pathname;
const CHECK = process.argv.includes('--check');
const OUT = join(ROOT, 'static/reckons-code-files.ttl');
const CODEBASE = join(ROOT, 'static/reckons-codebase.ttl');
const KPRED = 'urn:kbase:predicate/';
const FILE_NS = 'urn:reckons:file/';

// ── Source files ─────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!/node_modules|\.svelte-kit|\.git|dist|build/.test(p)) walk(p, out);
    } else if (/\.(ts|svelte|js)$/.test(e.name)) out.push(relative(ROOT, p));
  }
  return out;
}

const files = ['src', 'scripts', 'mcp-server/src', 'cli']
  .filter((d) => existsSync(join(ROOT, d)))
  .flatMap((d) => walk(join(ROOT, d)))
  .sort();

// ── Which module owns each file ──────────────────────────────────────────────

const codeQuads = new Parser().parse(readFileSync(CODEBASE, 'utf8'));
const ownerOf = new Map<string, string>();
for (const q of codeQuads) {
  if (q.predicate.value === KPRED + 'has-file') ownerOf.set(q.object.value, q.subject.value);
}
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
const moduleFor = (f: string): string | null =>
  ownerOf.get(f) ?? modulePrefixes.find((p) => f.startsWith(p.prefix + '/'))?.iri ?? null;

// ── Imports ──────────────────────────────────────────────────────────────────

const CANDIDATES = ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js'];
function resolveImport(from: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('$lib')) base = join(ROOT, 'src/lib', spec.slice(4));
  else if (spec.startsWith('$app') || spec.startsWith('$env')) return null;
  else if (spec.startsWith('.')) base = resolve(ROOT, dirname(from), spec);
  else return null;
  for (const ext of CANDIDATES) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return relative(ROOT, p);
  }
  return null;
}

const IMPORT_RE = /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;
const imports = new Map<string, Set<string>>();
const fileSet = new Set(files);
for (const f of files) {
  const text = readFileSync(join(ROOT, f), 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const t = resolveImport(f, m[1]);
    if (!t || t === f || !fileSet.has(t)) continue;
    if (!imports.has(f)) imports.set(f, new Set());
    imports.get(f)!.add(t);
  }
}

// ── Emit ─────────────────────────────────────────────────────────────────────

const iri = (f: string) => `<${FILE_NS}${f}>`;
const isTest = (f: string) => /(\.test\.|\.spec\.|__tests__\/)/.test(f);

const edgeCount = [...imports.values()].reduce((n, s) => n + s.size, 0);
const lines: string[] = [
  '## =============================================================================',
  '## Reckons.AI Code — FILE GRAPH',
  '## =============================================================================',
  '## GENERATED by scripts/offline/generate-file-graph.ts. Do not hand-edit; the whole',
  '## file is rewritten on every run.',
  '##',
  '## Why it exists (Matt, 2026-08-14): "we need that file granularity, in the code graph,',
  '## to achieve a clear scope estimate". reckons-codebase.ttl records files as LITERALS,',
  '## and nothing can be said about a literal — no file-to-file edge, no blast radius, and',
  '## no way for a design to name the files it touches. Here each file is an ENTITY.',
  '##',
  '## Kept separate from the hand-maintained module map so regenerating this never',
  '## overwrites something a person wrote.',
  '##',
  '## HONEST LIMITS: static imports only, so dynamic `await import()` (used heavily in',
  '## src/lib/stores) is invisible and coupling is UNDER-counted there. Type-only imports',
  '## are not distinguished from value imports, so coupling is OVER-counted elsewhere.',
  '## File granularity, not symbol — see kb:serena-prior-art for what would fix that.',
  '##',
  `## ${files.length} files · ${edgeCount} import edges · generated ${new Date().toISOString().slice(0, 10)}`,
  '## =============================================================================',
  '',
  '@prefix rdf:    <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .',
  '@prefix rdfs:   <http://www.w3.org/2000/01/rdf-schema#> .',
  '@prefix skos:   <http://www.w3.org/2004/02/skos/core#> .',
  '@prefix ktype:  <urn:kbase:type/> .',
  '@prefix kpred:  <urn:kbase:predicate/> .',
  '@prefix code:   <urn:reckons:code/> .',
  '',
];

for (const f of files) {
  const mod = moduleFor(f);
  lines.push(`${iri(f)} rdf:type ktype:SourceFile ;`);
  lines.push(`    rdfs:label ${JSON.stringify(basename(f))} ;`);
  lines.push(`    kpred:path ${JSON.stringify(f)} ;`);
  if (isTest(f)) lines.push('    kpred:is-test "true" ;');
  if (mod) lines.push(`    skos:broader ${mod.replace('urn:reckons:code/', 'code:')} ;`);
  const deps = [...(imports.get(f) ?? [])].sort();
  if (deps.length > 0) {
    lines.push(...deps.map((d, i) => `    kpred:imports ${iri(d)}${i === deps.length - 1 ? ' .' : ' ;'}`));
  } else {
    // Close the statement on the last property written.
    const last = lines.pop()!;
    lines.push(last.replace(/ ;$/, ' .'));
  }
  lines.push('');
}

const out = lines.join('\n');

if (CHECK) {
  const current = readTextOr(OUT, '');
  // Ignore the generated-on date so a re-run on another day is not "stale".
  const strip = (s: string) => s.replace(/generated \d{4}-\d{2}-\d{2}/, '');
  if (strip(current) !== strip(out)) {
    console.error('\x1b[31mfile graph is STALE\x1b[0m — run: npx tsx scripts/offline/generate-file-graph.ts');
    process.exit(1);
  }
  console.log(`\x1b[32mfile graph current\x1b[0m \x1b[2m(${files.length} files, ${edgeCount} edges)\x1b[0m`);
  process.exit(0);
}

writeFileSync(OUT, out);
console.log(
  `\x1b[1mfile graph generated\x1b[0m — ${files.length} file entities, ${edgeCount} import edges\n` +
    `\x1b[2m${relative(ROOT, OUT)}\x1b[0m`,
);
