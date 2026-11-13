#!/usr/bin/env npx tsx
/**
 * SCRIPT-TIER RUNS NAME NO MODEL — F286.6 (script tier).
 *
 * A passed script-tier run must be summarized by rule (exit code, duration, pass/fail lines), so its
 * JobRun record must not say a local model read it. This scans job-runs.ttl for passed runs of the
 * last day whose job is script tier in static/reckons-jobs.ttl and whose kpred:read-by names a model.
 * Exit 0 none, 1 at least one (names the job and run, nothing else), 2 nothing to read.
 *
 * WEAKNESS: it trusts kpred:read-by, which job-watch writes; it cannot see a model call that was not recorded.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import { runsTtlPath, slug } from '../agent/job-state.js';

const K = 'urn:kbase:predicate/';
const props = (ttl: string): Map<string, Record<string, string>> => {
  const by = new Map<string, Record<string, string>>();
  for (const q of new Parser().parse(ttl)) {
    if (!q.predicate.value.startsWith(K)) continue;
    const o = by.get(q.subject.value) ?? {};
    o[q.predicate.value.slice(K.length)] = q.object.value;
    by.set(q.subject.value, o);
  }
  return by;
};

/** Job names (slugged) of script tier, from the jobs graph text. */
export function scriptTierJobs(jobsTtl: string): Set<string> {
  const out = new Set<string>();
  for (const [iri, o] of props(jobsTtl)) if (o['job-tier'] === 'script') out.add(iri.replace('urn:reckons:job/', ''));
  return out;
}

export type Offender = { run: string; job: string; readBy: string };

export function scriptRunsNamingModel(runsTtl: string, scriptJobs: Set<string>, now: Date, windowMs = 86_400_000): Offender[] {
  const out: Offender[] = [];
  for (const [iri, o] of props(runsTtl)) {
    if (!o['job-name'] || !o.started || o['has-status'] !== 'passed') continue;
    if (now.getTime() - new Date(o.started).getTime() > windowMs) continue;
    if (!scriptJobs.has(slug(o['job-name']))) continue;
    if (/local model/i.test(o['read-by'] ?? '')) out.push({ run: iri, job: o['job-name'], readBy: o['read-by'] });
  }
  return out;
}

function main(): void {
  const jobsFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../static/reckons-jobs.ttl');
  const runsFile = runsTtlPath();
  if (!existsSync(jobsFile) || !existsSync(runsFile)) { console.log('script-tier-model-check: no run history on this machine, nothing to check'); process.exit(2); }
  const bad = scriptRunsNamingModel(readFileSync(runsFile, 'utf8'), scriptTierJobs(readFileSync(jobsFile, 'utf8')), new Date());
  if (!bad.length) { console.log('script-tier-model-check: 0 passed script-tier runs in the last day name a model'); return; }
  console.error(`script-tier-model-check: ${bad.length} passed script-tier run(s) in the last day name a model`);
  for (const b of bad.slice(0, 30)) console.error(`  ${b.job}: ${b.run}`);
  process.exit(1);
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
