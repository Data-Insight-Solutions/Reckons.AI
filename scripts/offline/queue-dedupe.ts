#!/usr/bin/env npx tsx
/**
 * QUEUE DEDUPE (SCRIPT tier) — stop the same finding being queued over and over.
 *
 * WHY THIS EXISTS. On 2026-08-15 the pending queue held 904 entries and had never been ruled on.
 *
 * A first measurement said half the queue was duplicated. That was WRONG, and the way it was wrong
 * matters more than the number: it keyed on the question TEXT alone, so 345 branch-align findings
 * that say the same sentence about 345 DIFFERENT entities all counted as copies of each other. The
 * identity of a finding is subject + predicate + text, and under that key the real figure is 115
 * duplicates — 13%. Same sentence, different subject, is two findings.
 *
 * What survives the correction is the part that actually hurt. The single worst duplicate was
 * reported FIFTY-NINE times:
 *
 *   "reckons-workspace/kbs/integrations-tech/integrations-tech.ttl does not parse as ttl"
 *
 * and it was a REAL defect that stayed unfixed the whole time. That is the failure mode CLAUDE.md
 * warns about, arriving from an angle nobody watched: the noise did not merely add triage cost, it
 * buried a true finding 59 layers deep. (It turned out to be two bad lines in a 944-line graph —
 * an `undefined` object and a literal node-key written as an IRI. Repaired, 844 quads recovered.)
 *
 * SCRIPT TIER ON PURPOSE. The obvious reach here is an agent that reads the queue and judges what
 * matters. But "is this the same sentence I already queued?" is decided by a rule, and the
 * promotion ladder says take the cheapest tier that can do it correctly. Deduplication is right by
 * construction, costs nothing, and removes work instead of moving it — an agent triaging 904
 * entries would have spent a chunk of its budget rediscovering which ones were copies.
 *
 * The jobs that produce duplicates are the ones missing an idempotency guard on re-run:
 * alignment-sweep (66) and button-crawl (47) between them account for 98% of them. graph-lint has
 * such a guard and contributes none, which is the argument that the guard belongs in the shared
 * append path rather than being re-implemented per job.
 *
 * SUPERSEDING, which is a different and larger effect. Some jobs RE-DERIVE their findings from
 * scratch on every run, so an older proposal about the same subject and predicate is not a
 * duplicate — it is a stale computation that the newer run has already replaced. branch-align had
 * run 14 times since 2026-07-12 and queued 345 proposals that reduce to 55 distinct
 * subject+predicate pairs; the other 290 were previous answers to a question that has been asked
 * again since.
 *
 * This ONLY applies to jobs that recompute. A one-time observation written by a human or by Opus is
 * not superseded by anything — nobody re-derived it — so those are never collapsed, however old.
 * Getting that backwards would silently delete the most considered entries in the queue, which is
 * why the recomputable jobs are named explicitly rather than inferred.
 *
 * Usage:
 *   npx tsx scripts/offline/queue-dedupe.ts             # report only
 *   npx tsx scripts/offline/queue-dedupe.ts --write     # collapse exact duplicates
 *   npx tsx scripts/offline/queue-dedupe.ts --supersede # also keep only the newest recomputed run
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname;
const QUEUE = join(ROOT, 'reckons-workspace/knowledge.pending.jsonl');
const SUPERSEDE = process.argv.includes('--supersede');
const WRITE = process.argv.includes('--write') || SUPERSEDE;

/**
 * Jobs that derive their findings fresh from the graph and the repo on every run, so the newest
 * run is the only one that describes the world as it currently is.
 *
 * Named explicitly, and deliberately NOT including `claude-code`, `opus:*` or `council:*`: those
 * are one-time human or model observations, nothing recomputes them, and treating an old one as
 * "superseded" would throw away the entries that took the most thought to write.
 */
const RECOMPUTABLE = new Set([
  'offline:branch-align',
  'offline:alignment-sweep',
  'offline:graph-lint',
  'offline:server-health',
  'offline:competitor-scan',
  'offline:proposal-yield',
]);

if (!existsSync(QUEUE)) {
  console.log('No pending queue at reckons-workspace/knowledge.pending.jsonl — nothing to do.');
  process.exit(0);
}

type Row = Record<string, unknown> & { subject?: string; predicate?: string; agent?: string };

const lines = readFileSync(QUEUE, 'utf8').split('\n');
const rows: { raw: string; row: Row }[] = [];
let unparseable = 0;
for (const raw of lines) {
  if (!raw.trim()) continue;
  try {
    rows.push({ raw, row: JSON.parse(raw) as Row });
  } catch {
    unparseable++; // keep the count honest rather than silently dropping
  }
}

/**
 * Identity of a finding. Subject + predicate + the text a human would read.
 *
 * Deliberately NOT including the timestamp, which is what made these duplicates in the first
 * place: the same finding re-queued on a later run differs only by addedAt, so any key including
 * it would call every copy unique and this script would report a clean queue.
 */
const identity = (r: Row): string => {
  const text = String(r.question ?? r.object ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${r.subject ?? ''}|${r.predicate ?? ''}|${text}`;
};

const seen = new Map<string, number>();
const kept: string[] = [];
const dupesByAgent = new Map<string, number>();
const worst = new Map<string, { n: number; text: string }>();

for (const { raw, row } of rows) {
  const id = identity(row);
  const n = (seen.get(id) ?? 0) + 1;
  seen.set(id, n);
  if (n === 1) {
    kept.push(raw);
  } else {
    const agent = String(row.agent ?? 'unknown').split(' ')[0];
    dupesByAgent.set(agent, (dupesByAgent.get(agent) ?? 0) + 1);
  }
  const w = worst.get(id) ?? { n: 0, text: String(row.question ?? row.object ?? '') };
  w.n = n;
  worst.set(id, w);
}

// ── Supersede: for recomputing jobs, keep only the newest run per subject+predicate ──
let superseded = 0;
let final = kept;
if (SUPERSEDE) {
  const parsed = kept.map((raw) => ({ raw, row: JSON.parse(raw) as Row }));
  const newest = new Map<string, string>();
  for (const { row } of parsed) {
    const agent = String(row.agent ?? '').split(' ')[0];
    if (!RECOMPUTABLE.has(agent)) continue;
    const k = `${agent}|${row.subject ?? ''}|${row.predicate ?? ''}`;
    const at = String(row.addedAt ?? '');
    if (!newest.has(k) || at > newest.get(k)!) newest.set(k, at);
  }
  final = parsed
    .filter(({ row }) => {
      const agent = String(row.agent ?? '').split(' ')[0];
      if (!RECOMPUTABLE.has(agent)) return true; // one-time notes are never superseded
      const k = `${agent}|${row.subject ?? ''}|${row.predicate ?? ''}`;
      const keep = String(row.addedAt ?? '') === newest.get(k);
      if (!keep) superseded++;
      return keep;
    })
    .map((p) => p.raw);
}

const removed = rows.length - kept.length;

console.log(`\x1b[1mqueue dedupe\x1b[0m \x1b[2m— ${rows.length} entr(ies), ${seen.size} unique\x1b[0m\n`);
if (unparseable) console.log(`  \x1b[33m${unparseable} line(s) did not parse as JSON and were left untouched\x1b[0m\n`);

if (removed === 0 && superseded === 0) {
  console.log('\x1b[32mNo duplicates\x1b[0m — every queued finding is distinct and current.');
  process.exit(0);
}

console.log(`  \x1b[31m${removed}\x1b[0m duplicate entr(ies) — \x1b[1m${Math.round((removed / rows.length) * 100)}%\x1b[0m of the queue\n`);
console.log('  by the job that queued them:');
for (const [agent, n] of [...dupesByAgent].sort((a, b) => b[1] - a[1]).slice(0, 6)) {
  console.log(`    ${String(n).padStart(4)}  ${agent}`);
}
console.log('\n  most-repeated findings:');
for (const [, w] of [...worst].sort((a, b) => b[1].n - a[1].n).slice(0, 5)) {
  if (w.n < 2) continue;
  console.log(`    x${String(w.n).padStart(3)}  ${w.text.replace(/\s+/g, ' ').slice(0, 96)}`);
}

if (superseded) {
  console.log(`\n  \x1b[33m${superseded}\x1b[0m entr(ies) superseded by a newer run of the same recomputing job.`);
}

if (!WRITE) {
  console.log('\n\x1b[2mReport only. Re-run with --write to collapse them, keeping the first of each.\x1b[0m');
  process.exit(0);
}

copyFileSync(QUEUE, QUEUE + '.bak');
writeFileSync(QUEUE, final.join('\n') + '\n');
console.log(
  `\n\x1b[32mRewrote\x1b[0m ${QUEUE.replace(ROOT, '')} — ${final.length} kept, ` +
    `${removed} duplicate(s) collapsed` + (superseded ? `, ${superseded} stale recomputation(s) superseded` : '') + '.',
);
console.log(`\x1b[2mPrevious contents saved alongside as .bak\x1b[0m`);
