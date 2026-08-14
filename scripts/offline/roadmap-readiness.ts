#!/usr/bin/env npx tsx
/**
 * Roadmap readiness (F26) — how much DEFINITION is missing before work can start.
 *
 * SCRIPT TIER: deterministic, zero tokens, no model.
 *
 * Matt (2026-07-30): measure the roadmap and production graphs for MISSING FACTS the same way
 * they are already measured for "required by". A feature with few missing facts is faster and
 * cheaper to start, because the definition needed to begin already exists in the graph instead of
 * having to be re-derived — which is the single largest token cost in a build session.
 *
 * THE TWO AXES, and why both are needed:
 *
 *   REQUIRED-BY   how many features transitively depend on this one. Impact. Already the basis of
 *                 the review queue's blast-radius ranking, applied here to the plan itself.
 *   MISSING       which facts a builder would need and cannot find. Cost to START — distinct from
 *                 cost to BUILD, which nothing here claims to estimate.
 *
 * High required-by AND low missing is the next thing to build. High required-by and high missing
 * is the next thing to DEFINE, and saying which of those two a feature needs is the actual output.
 *
 * WHY NOT DATES. Estimates in weeks or quarters are calibrated on human teams coordinating, which
 * is not what builds this. The unit here is missing facts and (where recorded) tokens; nothing in
 * this script produces a calendar.
 *
 * WHAT "MISSING" MEANS IS DELIBERATELY NARROW. Only facts whose absence actually blocks starting:
 * what it is, what state it is in, what is left, and whether anything it depends on is unbuilt.
 * A wider net would score prose density, and a feature is not better defined for being longer.
 *
 * Usage: npm run roadmap:readiness [--all] [--json]
 */

import { Parser, type Quad } from 'n3';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '../..');
const ROADMAP = join(ROOT, 'static/reckons-roadmap.ttl');

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const K = 'urn:kbase:predicate/';
const FEATURE_TYPE = 'urn:kbase:type/Feature';

/** Statuses that mean the thing exists well enough to be depended on. */
const BUILT = new Set(['functional', 'production']);
/** Only these are candidates to start; the rest are done or not yet real work. */
const STARTABLE = new Set(['planned', 'scaffolded', 'in-progress']);

const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
};

interface Feature {
  iri: string;
  id: string;
  label: string;
  status: string;
  dependsOn: string[];
  missing: string[];
  openQuestions: number;
  requiredBy: number;
}

function load(): Map<string, Feature> {
  const quads: Quad[] = new Parser().parse(readFileSync(ROADMAP, 'utf8'));
  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) bySubject.set(q.subject.value, [...(bySubject.get(q.subject.value) ?? []), q]);

  const features = new Map<string, Feature>();
  for (const [iri, own] of bySubject) {
    if (!own.some((q) => q.predicate.value === RDF_TYPE && q.object.value === FEATURE_TYPE)) continue;
    const one = (p: string) => own.find((q) => q.predicate.value === p)?.object.value ?? '';
    const many = (p: string) => own.filter((q) => q.predicate.value === p).map((q) => q.object.value);

    const status = one(`${K}has-status`);
    const missing: string[] = [];

    // Each entry is a fact whose ABSENCE blocks starting — not a completeness score.
    if (!one(`${K}description`)) missing.push('description — nobody can tell what it is');
    if (!status) missing.push('has-status — nobody can tell what state it is in');
    // `remaining` is what a builder reads first. Only meaningful for things not yet finished.
    if (STARTABLE.has(status) && many(`${K}remaining`).length === 0) {
      missing.push('remaining — nobody can tell what is left to do');
    }
    // A scaffolded/in-progress feature claiming no evidence cannot be trusted about its own state.
    if ((status === 'scaffolded' || status === 'in-progress')
      && !one(`${K}proof`) && many(`${K}honest-note`).length === 0) {
      missing.push('proof or honest-note — the status is an unevidenced claim');
    }

    features.set(iri, {
      iri,
      id: one(`${K}feature-id`) || iri.split(/[/#]/).pop() || iri,
      label: one(RDFS_LABEL) || iri,
      status,
      dependsOn: many(`${K}depends-on`),
      missing,
      openQuestions: many(`${K}open-question`).length,
      requiredBy: 0,
    });
  }

  // Transitive required-by: how many features would be unblocked, directly or indirectly.
  for (const f of features.values()) {
    const seen = new Set<string>();
    const stack = [f.iri];
    while (stack.length) {
      const current = stack.pop()!;
      for (const other of features.values()) {
        if (!other.dependsOn.includes(current) || seen.has(other.iri)) continue;
        seen.add(other.iri);
        stack.push(other.iri);
      }
    }
    f.requiredBy = seen.size;
  }
  return features;
}

function main(): void {
  const all = process.argv.includes('--all');
  const features = load();

  const unbuiltDeps = (f: Feature) => f.dependsOn.filter((d) => {
    const dep = features.get(d);
    return dep ? !BUILT.has(dep.status) : false;
  });

  const candidates = [...features.values()]
    .filter((f) => all || STARTABLE.has(f.status))
    // Most-depended-on first; among equals, the best-defined first. That ordering IS the
    // recommendation: impact decides what matters, missing facts decide what is startable.
    .sort((a, b) => b.requiredBy - a.requiredBy
      || a.missing.length - b.missing.length
      || a.id.localeCompare(b.id));

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(candidates.map((f) => ({
      ...f, blockedBy: unbuiltDeps(f).map((d) => features.get(d)?.id ?? d),
    })), null, 2));
    return;
  }

  const totalMissing = candidates.reduce((n, f) => n + f.missing.length, 0);
  console.log('');
  console.log(C.bold('roadmap readiness') + C.dim(' — missing facts, not dates'));
  console.log(C.dim(`  ${candidates.length} startable features · ${totalMissing} missing facts total`));
  console.log(C.dim('  required-by = features transitively unblocked. missing = facts a builder needs and cannot find.'));
  console.log('');

  const ready = candidates.filter((f) => f.missing.length === 0 && unbuiltDeps(f).length === 0);
  const blocked = candidates.filter((f) => f.missing.length === 0 && unbuiltDeps(f).length > 0);
  const underdefined = candidates.filter((f) => f.missing.length > 0);

  const row = (f: Feature, extra = '') =>
    `  ${f.id.padEnd(8)} ${C.dim(`←${String(f.requiredBy).padStart(2)}`)}  ${f.label.slice(0, 52).padEnd(52)}${extra}`;

  console.log(C.green(C.bold(`  READY TO BUILD (${ready.length})`)) + C.dim(' — defined, and nothing it needs is unbuilt'));
  for (const f of ready.slice(0, 12)) console.log(row(f, C.dim(` ${f.status}`)));

  if (blocked.length > 0) {
    console.log('');
    console.log(C.yellow(C.bold(`  DEFINED BUT BLOCKED (${blocked.length})`)) + C.dim(' — build the dependency first'));
    for (const f of blocked.slice(0, 8)) {
      console.log(row(f, C.dim(` needs ${unbuiltDeps(f).map((d) => features.get(d)?.id ?? '?').join(', ')}`)));
    }
  }

  if (underdefined.length > 0) {
    console.log('');
    console.log(C.red(C.bold(`  NEEDS DEFINING FIRST (${underdefined.length})`))
      + C.dim(' — starting these costs extra because the definition is not in the graph'));
    for (const f of underdefined.slice(0, 10)) {
      console.log(row(f));
      for (const m of f.missing) console.log(C.dim(`             missing: ${m}`));
    }
  }

  console.log('');
  console.log(C.dim('  A feature high in required-by AND with no missing facts is the next thing to BUILD.'));
  console.log(C.dim('  High required-by WITH missing facts is the next thing to DEFINE — cheaper than'));
  console.log(C.dim('  re-deriving that definition inside every session that touches it.'));
}

main();
