#!/usr/bin/env npx tsx
/**
 * PREPARE A FEATURE TO WORK ON — the brief, assembled from the graph (SCRIPT tier).
 *
 * Pulls everything the new tracking knows about one design into the thing you actually need
 * before starting: what it is, where it will work, what the estimate is and whether the graph
 * agrees with it, how to approach it, and what "done" means as a checkable list.
 *
 * STRATEGY SELECTION IS BORROWED, and worth crediting. dotnet/skills'
 * code-testing-generator.agent.md picks Direct / Single Pass / Iterative by the SIZE of the
 * job, and — the part that makes it more than a nicety — insists that "all strategies MUST
 * execute Steps 6-9", so the validation gates never scale down with the work. We already have
 * a size number (the scope estimate) that was doing nothing but being compared after the fact.
 * Using it to choose an approach BEFORE starting is what turns an estimate from a scorecard
 * into a decision.
 *
 * THE CHECKLIST IS ALSO THEIRS: converting a request into "independently verifiable checklist
 * items" and mapping each to a test at the end. kpred:remaining already holds that text in
 * prose; splitting it into items makes the mapping possible.
 *
 * Usage: npx tsx scripts/offline/prepare-feature.ts --feature=F122
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser } from 'n3';
import {
  deriveScope, checkEstimate, suggestEstimate, estimateFromFiles, highBlastFiles,
  type ModuleFacts,
} from '../../src/lib/rdf/scope-derive.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const ONLY = process.argv.find((a) => a.startsWith('--feature='))?.split('=')[1];
if (!ONLY) {
  console.error('Usage: prepare-feature.ts --feature=F122');
  process.exit(1);
}

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const quads = new Parser().parse(readFileSync(join(ROOT, 'static/reckons-roadmap.ttl'), 'utf8'));
const codeQuads = new Parser().parse(readFileSync(join(ROOT, 'static/reckons-codebase.ttl'), 'utf8'));

const moduleFiles = new Map<string, string[]>();
const moduleLabel = new Map<string, string>();
for (const q of codeQuads) {
  if (q.predicate.value === KPRED + 'has-file')
    moduleFiles.set(q.subject.value, [...(moduleFiles.get(q.subject.value) ?? []), q.object.value]);
  else if (q.predicate.value === RDFS_LABEL) moduleLabel.set(q.subject.value, q.object.value);
}

// The FILE graph — what makes an estimate a number rather than a range.
const importedBy = new Map<string, Set<string>>();
try {
  const fileQuads = new Parser().parse(readFileSync(join(ROOT, 'static/reckons-code-files.ttl'), 'utf8'));
  const pathOf = new Map<string, string>();
  for (const q of fileQuads) if (q.predicate.value === KPRED + 'path') pathOf.set(q.subject.value, q.object.value);
  for (const q of fileQuads) {
    if (q.predicate.value !== KPRED + 'imports') continue;
    const from = pathOf.get(q.subject.value);
    const to = pathOf.get(q.object.value);
    if (!from || !to) continue;
    if (!importedBy.has(to)) importedBy.set(to, new Set());
    importedBy.get(to)!.add(from);
  }
} catch { /* file graph not generated — module bounds only */ }

// Find the design by feature-id.
let iri: string | null = null;
for (const q of quads) if (q.predicate.value === KPRED + 'feature-id' && q.object.value === ONLY) iri = q.subject.value;
if (!iri) {
  console.error(`No design carries feature-id ${ONLY}.`);
  process.exit(1);
}

const facts = new Map<string, string[]>();
for (const q of quads) {
  if (q.subject.value !== iri) continue;
  const k = q.predicate.value === RDFS_LABEL ? 'label' : q.predicate.value.replace(KPRED, '');
  facts.set(k, [...(facts.get(k) ?? []), q.object.value]);
}
const one = (k: string) => facts.get(k)?.[0];
const all = (k: string) => facts.get(k) ?? [];

const modules: ModuleFacts[] = all('touches-module').map((m) => ({
  iri: m,
  label: moduleLabel.get(m),
  files: moduleFiles.get(m) ?? [],
}));
const derived = deriveScope(modules);
const estimate = one('estimated-files') ? Number(one('estimated-files')) : undefined;
const verdict = estimate !== undefined ? checkEstimate(estimate, derived) : null;

/**
 * Approach, chosen by the estimate.
 *
 * The thresholds are a stated convention, not a measurement — there is no estimate-versus-
 * actual history yet to calibrate them against. What is NOT negotiable is the gate line
 * below: the dotnet agent's insistence that validation runs whatever the size is the reason
 * the idea is worth borrowing at all.
 */
function strategy(files: number | undefined): { name: string; why: string } {
  if (files === undefined) return { name: 'UNKNOWN', why: 'no estimate — write one before starting' };
  if (files <= 3) return { name: 'DIRECT', why: 'small and self-contained; build it in one pass' };
  if (files <= 10)
    return { name: 'SINGLE PASS', why: 'a few modules; plan the phases, then implement in one sitting' };
  return { name: 'ITERATIVE', why: 'large; split into phases that each land green on their own' };
}

const s = strategy(estimate);
const bar = '─'.repeat(74);

console.log(`\n\x1b[1m${ONLY} — ${one('label') ?? iri}\x1b[0m`);
console.log(`\x1b[2m${one('has-status') ?? '?'}${one('priority') ? ` · ${one('priority')} priority` : ''}\x1b[0m`);
console.log(bar);

if (one('description')) {
  console.log(`\n${one('description')!.replace(/(.{92}\S*)\s+/g, '$1\n')}\n`);
}

console.log('\x1b[1mSCOPE\x1b[0m');
if (modules.length === 0) {
  console.log('  \x1b[33mNo modules named\x1b[0m — the estimate cannot be bounded by the graph.');
} else {
  for (const m of modules) {
    console.log(`  ${m.iri.replace('urn:reckons:code/', 'code:').padEnd(18)} ${String(m.files.length).padStart(3)} files  \x1b[2m${m.label ?? ''}\x1b[0m`);
  }
  console.log(`  \x1b[2mceiling ${derived.upperBound} files across ${modules.length} module(s); graph suggests ~${suggestEstimate(derived)}\x1b[0m`);
}
const namedFiles = all('touches-file');
if (namedFiles.length > 0 && importedBy.size > 0) {
  const fe = estimateFromFiles(namedFiles, importedBy);
  console.log(`\n  \x1b[1mfiles named\x1b[0m (${fe.floor}):`);
  for (const f of namedFiles) {
    const deps = importedBy.get(f)?.size ?? 0;
    console.log(`    ${f}${deps > 0 ? `  \x1b[2m<- ${deps} importer(s)\x1b[0m` : ''}`);
  }
  console.log(
    `  \x1b[1mfloor ${fe.floor}\x1b[0m · likely \x1b[1m${fe.likely}\x1b[0m (named + direct dependents) · ceiling ${fe.ceiling}`,
  );
  const hot = highBlastFiles(importedBy).filter((h) => namedFiles.includes(h.file));
  for (const h of hot) {
    console.log(`  \x1b[33m! ${h.file} has ${h.dependents} importers — changing its exports reaches far\x1b[0m`);
  }
}
console.log(`  estimate: \x1b[1m${estimate ?? '—'}\x1b[0m file(s), ${one('estimated-deps') ?? '—'} new dep(s)`);
if (verdict) {
  const colour = verdict.kind === 'plausible' ? '\x1b[32m' : '\x1b[33m';
  console.log(`  ${colour}${verdict.kind}\x1b[0m${verdict.kind !== 'plausible' && 'message' in verdict ? ` \x1b[2m${verdict.message}\x1b[0m` : ''}`);
}

console.log(`\n\x1b[1mAPPROACH\x1b[0m  ${s.name} \x1b[2m— ${s.why}\x1b[0m`);
console.log(
  '  \x1b[2mThe gates do NOT scale down with the work: unit tests, svelte-check, graph-lint,\n' +
    '  SHACL and the script tier run whatever the strategy.\x1b[0m',
);

// The checklist: kpred:remaining already states what is left, in prose.
const remaining = all('remaining');
if (remaining.length) {
  console.log('\n\x1b[1mDONE WHEN\x1b[0m \x1b[2m(from kpred:remaining — each item wants its own test)\x1b[0m');
  for (const r of remaining) {
    for (const item of r.split(/;\s+|\.\s+(?=[A-Z])/).map((x) => x.trim()).filter((x) => x.length > 12)) {
      console.log(`  ☐ ${item.replace(/(.{86}\S*)\s+/g, '$1\n     ')}`);
    }
  }
}

const openQ = all('open-question');
if (openQ.length) {
  console.log('\n\x1b[1mUNDECIDED\x1b[0m \x1b[2m(answer before building, or the work will guess)\x1b[0m');
  for (const q of openQ) console.log(`  ? ${q.slice(0, 160)}${q.length > 160 ? '…' : ''}`);
}

console.log('\n\x1b[1mTRACK IT\x1b[0m');
console.log(`  \x1b[2mnpx tsx scripts/offline/scope-check.ts --feature=${ONLY} --base=<branch-point>\x1b[0m`);
console.log('  \x1b[2mrecord kpred:actual-files / actual-deps when it lands; justify any increase\x1b[0m');
console.log(bar + '\n');
