#!/usr/bin/env npx tsx
/**
 * SET INTEGRITY (F187) — every member of a set must be a thing that exists. Script tier.
 *
 * WHY IT EXISTS — a real failure, on the day sets first rendered (2026-09-09).
 *
 * The five-move sets in static/docs-features.ttl named feat:TurtleExport, feat:GraphIdentity and
 * feat:SourceTrust. None of the three existed: the entities are feat:TTLExport, feat:KBIdentity and
 * feat:TrustSystem, and the set was authored from the LABELS rather than the IRIs. Turtle is happy
 * to state a relation to a subject nobody has described, so nothing complained.
 *
 * What made it worth a gate rather than a fix is what the page then SAID. The renderer counts
 * members it could not link and writes "2 more parts are covered inside the pages above" — which
 * was false. They were covered nowhere; they did not exist. A dangling member does not read as an
 * error to a reader, it reads as a promise, and kb:honest-status is explicit that a page must not
 * describe something that is not there.
 *
 * WHAT IS CHECKED, and each is a different mistake:
 *
 *   DANGLING     skos:member points at an IRI with no triples anywhere in the corpus. Almost
 *                always a typo or a guessed IRI, as above.
 *   EMPTY        a set with no members at all — a heading promising a list and delivering none.
 *   SELF         a set that is its own member, which renders as an infinite promise.
 *   ORPHAN SET   a set nothing points at with kpred:set-relates-to and that no other set contains.
 *                Not an error: an authored set may be waiting for its page. Reported so it is a
 *                decision rather than an oversight.
 *
 * Usage: npx tsx scripts/offline/set-integrity.ts [--quiet]
 */

import { Parser, type Quad } from 'n3';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readNotations, readSets, SET_RELATES_TO } from '../../src/lib/rdf/sets.js';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const STATIC_DIR = join(ROOT, 'static');
const QUIET = process.argv.includes('--quiet');

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`, dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`, green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`, cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function main(): void {
  const files = readdirSync(STATIC_DIR).filter((f) => f.endsWith('.ttl'));
  const all: Quad[] = [];
  const origin = new Map<string, string>();
  for (const f of files) {
    // docs-all.ttl is a concatenation of the others; counting it doubles every set.
    if (f === 'docs-all.ttl') continue;
    let quads: Quad[];
    try { quads = new Parser().parse(readFileSync(join(STATIC_DIR, f), 'utf8')); } catch { continue; }
    for (const q of quads) if (!origin.has(q.subject.value)) origin.set(q.subject.value, f);
    all.push(...quads);
  }

  // A subject that appears anywhere is a thing that exists. Deliberately generous: a member
  // described in one graph and grouped in another is fine, and only a total absence is an error.
  const described = new Set(all.map((q) => q.subject.value));
  const notations = readNotations(all as never[]);
  const sets = readSets(all as never[], notations);
  const setIris = new Set(sets.map((s) => s.iri));

  const relatedTo = new Set<string>();
  for (const q of all) if (q.predicate.value === SET_RELATES_TO) relatedTo.add(q.subject.value);
  const containedInAnotherSet = new Set(sets.flatMap((s) => s.members.map((m) => m.iri)));

  const dangling: Array<{ set: string; label: string; member: string; file: string }> = [];
  const empty: string[] = [];
  const selfRef: string[] = [];
  const orphanSets: string[] = [];

  for (const s of sets) {
    const file = origin.get(s.iri) ?? '?';
    if (s.members.length === 0) empty.push(`${s.label || s.iri} ${C.dim(`(${file})`)}`);
    for (const m of s.members) {
      if (m.iri === s.iri) selfRef.push(s.label || s.iri);
      else if (!described.has(m.iri)) dangling.push({ set: s.iri, label: s.label || s.iri, member: m.iri, file });
    }
    if (!relatedTo.has(s.iri) && !containedInAnotherSet.has(s.iri)) {
      orphanSets.push(`${s.label || s.iri} ${C.dim(`(${file}, ${s.members.length} member(s))`)}`);
    }
  }

  console.log('');
  console.log(C.bold('set integrity') + C.dim(` — ${sets.length} set(s) across ${files.length} graph(s)`));
  console.log('');

  if (dangling.length > 0) {
    console.log(C.red(C.bold(`  ${dangling.length} DANGLING member(s) — named by a set, described by nothing:`)));
    for (const d of dangling) {
      console.log(`    ${C.cyan(d.label)} → ${C.red(d.member)} ${C.dim(`(${d.file})`)}`);
    }
    console.log(C.dim('    A set that names a thing nobody described makes the page promise content'));
    console.log(C.dim('    that does not exist. Usually a guessed IRI: check the local name.'));
    console.log('');
  }
  if (selfRef.length > 0) {
    console.log(C.red(`  ${selfRef.length} set(s) contain themselves: ${selfRef.join(', ')}`));
    console.log('');
  }
  if (empty.length > 0) {
    console.log(C.yellow(`  ${empty.length} set(s) with no members:`));
    for (const e of empty) console.log(`    ${e}`);
    console.log('');
  }
  if (orphanSets.length > 0 && !QUIET) {
    console.log(C.dim(`  ${orphanSets.length} set(s) point at no page and sit inside no other set:`));
    for (const o of orphanSets) console.log(C.dim(`    ${o}`));
    console.log(C.dim('    Not a failure — an authored set may be waiting for its page. Listed so that'));
    console.log(C.dim('    is a decision somebody made rather than something nobody noticed.'));
    console.log('');
  }

  const errors = dangling.length + selfRef.length;
  if (errors === 0 && empty.length === 0) {
    console.log(C.green(`  every member of every set resolves to something that exists.`));
  }
  console.log(`  ${C.red(`${errors} error(s)`)}, ${empty.length} warning(s).`);
  if (errors > 0) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('set-integrity.ts')) main();
