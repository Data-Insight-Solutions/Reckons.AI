#!/usr/bin/env npx tsx
/**
 * DERIVE kpred:touches-module FROM EVIDENCE ALREADY IN THE GRAPH (F130.2, SCRIPT tier).
 *
 * Matt, 2026-08-14: the code graph should be "a source for the estimates, not just a random
 * guess." The edge that makes that possible is kpred:touches-module, and hand-writing it for
 * every design does not scale — measured 2026-08-14, 9 of 164 features carried it.
 *
 * But the graph already knows more than it says. 100 features carry kpred:tested-by pointing
 * at a real test path, and the codebase graph maps every module to its files, from which each
 * module's directory prefix falls out cleanly (code:rdf -> src/lib/rdf, code:stores ->
 * src/lib/stores). A test path therefore identifies its module deterministically, and a
 * feature tested by src/lib/rdf/__tests__/diff.test.ts demonstrably works in code:rdf.
 *
 * SO THIS DERIVES RATHER THAN GUESSES, and that distinction is the whole point: every link it
 * writes is entailed by two facts already in the graph. It is re-runnable and idempotent, so
 * the graph can be re-enriched whenever tested-by grows.
 *
 * HONEST LIMIT, and it is a real one: tested-by proves a feature touches the module its TESTS
 * live in. It does not prove that is the ONLY module the feature touches — a feature tested in
 * code:rdf may well also change code:stores, and this cannot see that. So the derived set is a
 * LOWER BOUND on the modules a design works in, which makes the derived file ceiling a lower
 * bound too. Under-stating a ceiling is the safe direction (it makes checkEstimate more likely
 * to say "you have not named every module"), but it must not be read as complete.
 *
 * Usage:
 *   npx tsx scripts/offline/derive-touches-module.ts            report what it would add
 *   npx tsx scripts/offline/derive-touches-module.ts --write    apply to the roadmap TTL
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';

const ROOT = new URL('../..', import.meta.url).pathname;
const WRITE = process.argv.includes('--write');
const ROADMAP = join(ROOT, 'static/reckons-roadmap.ttl');
const CODEBASE = join(ROOT, 'static/reckons-codebase.ttl');

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const FEATURE = 'urn:kbase:type/Feature';

// ── Module directory prefixes, from the codebase graph ───────────────────────

const codeQuads = new Parser().parse(readFileSync(CODEBASE, 'utf8'));
const moduleFiles = new Map<string, string[]>();
for (const q of codeQuads) {
  if (q.predicate.value === KPRED + 'has-file') {
    moduleFiles.set(q.subject.value, [...(moduleFiles.get(q.subject.value) ?? []), q.object.value]);
  }
}

/** The deepest directory every file in a module shares. Modules whose files sprawl across the
 *  repo (code:repo, code:design-system) yield no prefix and are skipped — a module that could
 *  match anything would match everything. */
const prefixes: Array<{ iri: string; prefix: string }> = [];
for (const [iri, files] of moduleFiles) {
  const dirs = files.map((p) => p.split('/').slice(0, -1).join('/'));
  const common = dirs.reduce((a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return a.slice(0, i);
  });
  const trimmed = common.replace(/\/$/, '');
  if (trimmed.includes('/')) prefixes.push({ iri, prefix: trimmed });
}
// Longest prefix wins, so src/lib/rdf beats src/lib.
prefixes.sort((a, b) => b.prefix.length - a.prefix.length);

function moduleForPath(path: string): string | null {
  return prefixes.find((p) => path.startsWith(p.prefix + '/'))?.iri ?? null;
}

// ── Features, their tests, and what they already declare ─────────────────────

const roadmapText = readFileSync(ROADMAP, 'utf8');
const quads = new Parser().parse(roadmapText);

const isFeature = new Set<string>();
const testedBy = new Map<string, string[]>();
const declared = new Map<string, Set<string>>();
const featureId = new Map<string, string>();

for (const q of quads) {
  const s = q.subject.value;
  if (q.predicate.value === RDF_TYPE && q.object.value === FEATURE) isFeature.add(s);
  else if (q.predicate.value === KPRED + 'tested-by') testedBy.set(s, [...(testedBy.get(s) ?? []), q.object.value]);
  else if (q.predicate.value === KPRED + 'touches-module') {
    if (!declared.has(s)) declared.set(s, new Set());
    declared.get(s)!.add(q.object.value);
  } else if (q.predicate.value === KPRED + 'feature-id') featureId.set(s, q.object.value);
}

type Addition = { iri: string; id?: string; modules: string[] };
const additions: Addition[] = [];
let unmapped = 0;

for (const iri of isFeature) {
  const tests = testedBy.get(iri) ?? [];
  if (tests.length === 0) continue;
  const derivedMods = new Set<string>();
  for (const t of tests) {
    const m = moduleForPath(t);
    if (m) derivedMods.add(m);
    else unmapped++;
  }
  const already = declared.get(iri) ?? new Set();
  const missing = [...derivedMods].filter((m) => !already.has(m));
  if (missing.length > 0) additions.push({ iri, id: featureId.get(iri), modules: missing });
}

// ── Report / write ───────────────────────────────────────────────────────────

console.log(
  `\x1b[1mderive touches-module\x1b[0m \x1b[2m— ${prefixes.length} module prefixes, ` +
    `${testedBy.size} feature(s) with tests\x1b[0m\n`,
);

if (additions.length === 0) {
  console.log('\x1b[32mNothing to add\x1b[0m — every tested feature already declares its modules.');
  process.exit(0);
}

for (const a of additions.slice(0, 15)) {
  console.log(
    `  ${(a.id ?? '').padEnd(9)} ${a.iri.replace('urn:kbase:concept/', '').padEnd(34)} ` +
      `+ ${a.modules.map((m) => m.replace('urn:reckons:code/', 'code:')).join(', ')}`,
  );
}
if (additions.length > 15) console.log(`  \x1b[2m… ${additions.length - 15} more\x1b[0m`);

console.log(
  `\n${additions.length} feature(s) would gain a total of ` +
    `${additions.reduce((n, a) => n + a.modules.length, 0)} link(s)` +
    (unmapped ? `; ${unmapped} test path(s) matched no module prefix` : ''),
);
console.log(
  '\x1b[2mDerived, not guessed: each link is entailed by tested-by plus has-file. This is a\n' +
    'LOWER BOUND on the modules a design touches — tests prove where a feature works, not\n' +
    'where it stops.\x1b[0m',
);

if (!WRITE) {
  console.log('\n\x1b[2mRe-run with --write to apply.\x1b[0m');
  process.exit(0);
}

let out = roadmapText;
let applied = 0;
for (const a of additions) {
  const local = a.iri.replace('urn:kbase:concept/', 'kb:');
  const re = new RegExp(`^(${local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} rdf:type\\s+ktype:Feature ;\\n)`, 'm');
  const m = out.match(re);
  if (!m) continue;
  const ins = a.modules
    .map((mod) => `               kpred:touches-module ${mod.replace('urn:reckons:code/', 'code:')} ;\n`)
    .join('');
  out = out.replace(re, `$1${ins}`);
  applied++;
}
writeFileSync(ROADMAP, out);
console.log(`\n\x1b[32mapplied to ${applied} feature(s)\x1b[0m`);
