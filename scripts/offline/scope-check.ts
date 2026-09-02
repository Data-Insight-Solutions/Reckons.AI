#!/usr/bin/env npx tsx
/**
 * SCOPE CHECK (F130.1, SCRIPT tier) — estimate vs actual, zero tokens.
 *
 * Reads kpred:estimated-files / kpred:estimated-deps from the roadmap and compares them with
 * what actually happened: files from `git diff --name-only`, new dependencies from the
 * package.json diff. The comparison itself is rdf/scope.ts, so the report and the app agree
 * about what creep means.
 *
 * WHAT THIS IS FOR, and it is not a grade. Matt, 2026-08-14: "drift warnings are a soft,
 * non-blocking warning system that the initial graph was not refined enough. The design
 * didn't account for everything." So exceeding an estimate is evidence about the DESIGN, and
 * the output is a prompt to refine it. This job NEVER fails a build: blocking on creep would
 * make the honest estimate the dangerous one and inflate every estimate until it meant
 * nothing.
 *
 * HONEST LIMIT: `git diff` gives the files changed on a BRANCH, not the files attributable to
 * one feature. Where a branch carries several concerns the actual is an over-count, and this
 * says so rather than pretending otherwise — which is itself an argument for one branch per
 * feature. --feature narrows the report to a single design but cannot narrow the diff.
 *
 * Usage:
 *   npx tsx scripts/offline/scope-check.ts --base=origin/dev
 *   npx tsx scripts/offline/scope-check.ts --feature=F122 --base=origin/dev
 *   npx tsx scripts/offline/scope-check.ts --calibration      estimates vs actuals on record
 */

import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { queueFindings } from './pending-queue.ts';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Parser } from 'n3';
import { measureCreep, shouldWarnOnCreep, describeCreep, type ScopeEstimate } from '../../src/lib/rdf/scope.ts';
import { deriveScope, checkEstimate, suggestEstimate, type ModuleFacts } from '../../src/lib/rdf/scope-derive.ts';

const ROOT = new URL('../..', import.meta.url).pathname;
const argv = process.argv.slice(2);
const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const BASE = arg('base') ?? 'origin/dev';
const ONLY = arg('feature');
const CALIBRATION = argv.includes('--calibration');
const PENDING_OUT = argv.includes('--pending');
const PENDING = join(ROOT, 'reckons-workspace/knowledge.pending.jsonl');

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

// ── Read designs that carry an estimate or an actual ─────────────────────────

type Design = {
  iri: string;
  id?: string;
  label?: string;
  estimate: ScopeEstimate;
  actual: ScopeEstimate;
  /** Code modules the design says it will work in (kpred:touches-module). */
  modules: string[];
};

const quads = new Parser().parse(readFileSync(join(ROOT, 'static/reckons-roadmap.ttl'), 'utf8'));
const designs = new Map<string, Design>();
const get = (iri: string) => {
  if (!designs.has(iri)) designs.set(iri, { iri, estimate: {}, actual: {}, modules: [] });
  return designs.get(iri)!;
};
for (const q of quads) {
  const p = q.predicate.value;
  const v = q.object.value;
  if (p === RDFS_LABEL) get(q.subject.value).label = v;
  else if (p === KPRED + 'feature-id') get(q.subject.value).id = v;
  else if (p === KPRED + 'estimated-files') get(q.subject.value).estimate.files = Number(v);
  else if (p === KPRED + 'estimated-deps') get(q.subject.value).estimate.dependencies = Number(v);
  else if (p === KPRED + 'actual-files') get(q.subject.value).actual.files = Number(v);
  else if (p === KPRED + 'actual-deps') get(q.subject.value).actual.dependencies = Number(v);
  else if (p === KPRED + 'touches-module') get(q.subject.value).modules.push(v);
}

// The code graph is what turns an estimate from a guess into a bounded claim.
const codeQuads = new Parser().parse(readFileSync(join(ROOT, 'static/reckons-codebase.ttl'), 'utf8'));
const moduleFiles = new Map<string, string[]>();
const moduleLabel = new Map<string, string>();
for (const q of codeQuads) {
  if (q.predicate.value === KPRED + 'has-file') {
    const k = q.subject.value;
    moduleFiles.set(k, [...(moduleFiles.get(k) ?? []), q.object.value]);
  } else if (q.predicate.value === RDFS_LABEL) moduleLabel.set(q.subject.value, q.object.value);
}
const factsFor = (iris: string[]): ModuleFacts[] =>
  iris.map((iri) => ({ iri, label: moduleLabel.get(iri), files: moduleFiles.get(iri) ?? [] }));

const withEstimate = [...designs.values()].filter((d) => Object.keys(d.estimate).length > 0);
const withActual = [...designs.values()].filter((d) => Object.keys(d.actual).length > 0);

// ── Calibration: how good have estimates been? ───────────────────────────────

if (CALIBRATION) {
  console.log('\x1b[1mscope calibration\x1b[0m \x1b[2m— designs carrying an estimate and/or a recorded actual\x1b[0m\n');
  const both = [...designs.values()].filter(
    (d) => d.estimate.files !== undefined && d.actual.files !== undefined,
  );
  console.log(`  ${withEstimate.length} design(s) carry a forward estimate`);
  console.log(`  ${withActual.length} design(s) carry a recorded actual`);
  console.log(`  ${both.length} carry BOTH — only these can score an estimate\n`);
  if (both.length === 0) {
    console.log(
      '\x1b[33mNo design yet has an estimate AND an actual, so estimate quality is unknown.\x1b[0m\n' +
        '\x1b[2mThat is expected on day one: the estimates on record were written BEFORE their work\n' +
        'and the actuals on record were measured for work that had no estimate. Back-filling an\n' +
        '"estimate" onto finished work would make this number a lie, so it stays empty until a\n' +
        'estimated feature is actually built.\x1b[0m',
    );
  }
  for (const d of both) {
    const r = measureCreep(d.estimate, d.actual);
    console.log(`  ${(d.id ?? d.iri).padEnd(8)} ${describeCreep(r, 'step')}`);
  }
  console.log('\n\x1b[2mActuals on record (no estimate — calibration input for future designs):\x1b[0m');
  for (const d of withActual.filter((x) => x.estimate.files === undefined)) {
    console.log(
      `  ${(d.id ?? '').padEnd(8)} ${String(d.actual.files ?? '?').padStart(2)} files` +
        `${d.actual.dependencies ? `, ${d.actual.dependencies} new dep(s)` : ''}  \x1b[2m${d.label ?? ''}\x1b[0m`,
    );
  }
  process.exit(0);
}

// ── In-flight: compare estimates against the working branch ──────────────────

function gitFilesChanged(): string[] {
  try {
    // execFileSync, not execSync: BASE comes from --base= on the command line and was being
    // interpolated into a SHELL string, so `--base='x; rm -rf ~'` would have run. Passing argv
    // as an array means git receives it as one argument and no shell is involved at all.
    const out = execFileSync('git', ['diff', '--name-only', `${BASE}...HEAD`], { cwd: ROOT, encoding: 'utf8' });
    const staged = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
    const fromStatus = staged
      .split('\n')
      .map((l) => l.slice(3).trim())
      .filter(Boolean);
    return [...new Set([...out.split('\n').filter(Boolean), ...fromStatus])];
  } catch {
    return [];
  }
}

function newDependencies(): number {
  try {
    const diff = execFileSync('git', ['diff', `${BASE}...HEAD`, '--', 'package.json'], { cwd: ROOT, encoding: 'utf8' });
    const staged = execFileSync('git', ['diff', 'HEAD', '--', 'package.json'], { cwd: ROOT, encoding: 'utf8' });
    const added = (diff + staged)
      .split('\n')
      .filter((l) => /^\+\s*"[^"]+":\s*"[^"]+"/.test(l) && !/^\+\s*"(name|version|type|description)"/.test(l));
    return added.length;
  } catch {
    return 0;
  }
}

const changed = gitFilesChanged();
// Source files only — a design's estimate is about code, not about the TTL that records it.
const sourceChanged = changed.filter((f) => /^(src|scripts|cli|mcp-server)\//.test(f));
const deps = newDependencies();

const targets = ONLY ? withEstimate.filter((d) => d.id === ONLY) : withEstimate;

console.log(
  `\x1b[1mscope check\x1b[0m \x1b[2m— vs ${BASE}: ${sourceChanged.length} source file(s) changed, ${deps} new dep(s)\x1b[0m`,
);
if (targets.length === 0) {
  console.log(
    `\n\x1b[33mNo design carries an estimate${ONLY ? ` for ${ONLY}` : ''}.\x1b[0m ` +
      '\x1b[2mAdd kpred:estimated-files / kpred:estimated-deps to the feature you are about to build.\x1b[0m',
  );
  process.exit(0);
}

console.log(
  '\n\x1b[2mThe branch diff cannot be split per feature, so a branch carrying several\n' +
    'concerns over-counts every one of them. Read accordingly.\x1b[0m\n',
);

const warnings: string[] = [];
for (const d of targets) {
  const derived = deriveScope(factsFor(d.modules));
  const verdict = d.estimate.files !== undefined ? checkEstimate(d.estimate.files, derived) : null;
  const readings = measureCreep(d.estimate, { files: sourceChanged.length, dependencies: deps });
  const warn = shouldWarnOnCreep(readings);
  const mark = warn ? '\x1b[33m!\x1b[0m' : '\x1b[32m✓\x1b[0m';
  console.log(`  ${mark} ${(d.id ?? '').padEnd(8)} ${d.label ?? d.iri}`);
  if (verdict) {
    if (verdict.kind === 'underivable') {
      console.log(`      \x1b[33mestimate is a GUESS\x1b[0m \x1b[2m${verdict.message}\x1b[0m`);
    } else if (verdict.kind === 'plausible') {
      const sug = suggestEstimate(derived);
      console.log(
        `      \x1b[2mderived from ${d.modules.length} module(s): up to ${verdict.upperBound} files` +
          `${sug !== null ? `, graph suggests ~${sug}` : ''} — estimate of ${d.estimate.files} is within bounds\x1b[0m`,
      );
    } else {
      console.log(`      \x1b[33m${verdict.message}\x1b[0m`);
    }
  }
  for (const r of readings) {
    console.log(
      `      ${r.dimension.padEnd(13)} estimated ${String(r.estimated).padStart(3)}  actual ${String(r.actual).padStart(3)}` +
        (r.over > 0 ? `  \x1b[33mover by ${r.over}\x1b[0m` : ''),
    );
  }
  if (warn) {
    const msg = describeCreep(readings, 'step');
    console.log(`      \x1b[2m${msg}\x1b[0m`);
    warnings.push(`${d.id ?? d.iri}: ${msg}`);
  }
}

if (PENDING_OUT && warnings.length > 0) {
  // Recomputing: every design carrying an estimate is re-scored on each run, so a design brought
  // back inside its estimate should stop being flagged instead of accumulating a history of
  // moments when it was not.
  const { queued, superseded } = queueFindings(
    warnings.map((w) => ({
      subject: 'urn:kbase:concept/scope-creep',
      predicate: 'urn:kbase:predicate/observed',
      object: w,
      note: 'Soft signal: the design did not account for everything. Refine the estimate or the design.',
      type: 'drift-warning' as const,
      findingClass: 'drift',
      priority: 'normal',
    })),
    { agent: 'offline:scope-check', path: PENDING, recomputes: true },
  );
  console.log(`\n\x1b[2mqueued ${queued} finding(s) for review${superseded ? `, ${superseded} resolved` : ''}\x1b[0m`);
}

// Never fails. Creep is a prompt to refine the design, not a broken invariant.
process.exit(0);
