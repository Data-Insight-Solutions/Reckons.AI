#!/usr/bin/env npx tsx
/**
 * QUEUE DEDUPE (SCRIPT tier) — stop the same finding being queued over and over.
 *
 * WHY THIS EXISTS. On 2026-08-15 the pending queue held 904 entries and had never been ruled on.
 *
 * A first measurement said half the queue was duplicated. That was WRONG, and the way it was wrong
 * matters more than the number: it keyed on the question TEXT alone, so 345 branch-align findings
 * that say the same sentence about 345 DIFFERENT entities all counted as copies of each other. The
 * identity of a finding is destination graph + subject + predicate + blockers + text, and under
 * the earlier subject/predicate/text key the real figure was 115 duplicates — 13%. Same sentence
 * about a different subject, graph, or blocked task is different work.
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

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from '../agent/state-file.js';
import {
  findingIdentity,
  normalizeFindingBlocks,
  normalizeFindingKb,
  transactPendingQueue,
} from './pending-queue.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
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

function recomputeKey(row: Row): string {
  const agent = String(row.agent ?? '').split(' ')[0];
  return `${agent}|${normalizeFindingKb(row.kb)}|${row.subject ?? ''}|${row.predicate ?? ''}|` +
    JSON.stringify(normalizeFindingBlocks(row.blocks));
}

function analyzeQueue(content: string) {
  const parsed: { raw: string; row: Row | null }[] = content.split('\n')
    .filter((raw) => raw.trim())
    .map((raw) => {
      try { return { raw, row: JSON.parse(raw) as Row }; }
      catch { return { raw, row: null }; }
    });
  const seen = new Map<string, number>();
  const kept: typeof parsed = [];
  const dupesByAgent = new Map<string, number>();
  const worst = new Map<string, { n: number; text: string }>();
  let unparseable = 0;

  for (const item of parsed) {
    if (!item.row) {
      unparseable++;
      kept.push(item); // malformed evidence is preserved byte-for-byte
      continue;
    }
    const id = findingIdentity(item.row);
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    if (n === 1) kept.push(item);
    else {
      const agent = String(item.row.agent ?? 'unknown').split(' ')[0];
      dupesByAgent.set(agent, (dupesByAgent.get(agent) ?? 0) + 1);
    }
    const worstEntry = worst.get(id) ?? { n: 0, text: String(item.row.question ?? item.row.object ?? '') };
    worstEntry.n = n;
    worst.set(id, worstEntry);
  }

  let superseded = 0;
  let final = kept;
  if (SUPERSEDE) {
    const newest = new Map<string, string>();
    for (const item of kept) {
      if (!item.row) continue;
      const agent = String(item.row.agent ?? '').split(' ')[0];
      if (!RECOMPUTABLE.has(agent)) continue;
      const key = recomputeKey(item.row);
      const at = String(item.row.addedAt ?? '');
      if (!newest.has(key) || at > newest.get(key)!) newest.set(key, at);
    }
    final = kept.filter((item) => {
      if (!item.row) return true;
      const agent = String(item.row.agent ?? '').split(' ')[0];
      if (!RECOMPUTABLE.has(agent)) return true;
      const keep = String(item.row.addedAt ?? '') === newest.get(recomputeKey(item.row));
      if (!keep) superseded++;
      return keep;
    });
  }

  return {
    rows: parsed.length,
    unparseable,
    seen,
    dupesByAgent,
    worst,
    removed: parsed.length - kept.length,
    superseded,
    final: final.map((item) => item.raw),
  };
}

const analysis = analyzeQueue(readFileSync(QUEUE, 'utf8'));
const { rows, unparseable, seen, dupesByAgent, worst, removed, superseded, final } = analysis;

console.log(`\x1b[1mqueue dedupe\x1b[0m \x1b[2m— ${rows} entr(ies), ${seen.size} unique\x1b[0m\n`);
if (unparseable) console.log(`  \x1b[33m${unparseable} line(s) did not parse as JSON and were left untouched\x1b[0m\n`);

if (removed === 0 && superseded === 0) {
  console.log('\x1b[32mNo duplicates\x1b[0m — every queued finding is distinct and current.');
  process.exit(0);
}

console.log(`  \x1b[31m${removed}\x1b[0m duplicate entr(ies) — \x1b[1m${Math.round((removed / rows) * 100)}%\x1b[0m of the queue\n`);
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

const written = transactPendingQueue(QUEUE, (current) => {
  const fresh = analyzeQueue(current);
  atomicWriteFile(QUEUE + '.bak', current);
  return {
    content: fresh.final.join('\n') + (fresh.final.length ? '\n' : ''),
    result: fresh,
  };
});
console.log(
  `\n\x1b[32mRewrote\x1b[0m ${QUEUE.replace(ROOT, '')} — ${written.final.length} kept, ` +
    `${written.removed} duplicate(s) collapsed` +
    (written.superseded ? `, ${written.superseded} stale recomputation(s) superseded` : '') + '.',
);
console.log(`\x1b[2mPrevious contents saved alongside as .bak\x1b[0m`);
