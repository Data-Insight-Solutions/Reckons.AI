#!/usr/bin/env npx tsx
/**
 * Remove queue rows that are not decisions (F74.3, script tier).
 *
 * A review queue earns a human's attention by containing only things a human can actually settle.
 * This one accumulated three kinds of row that cannot be:
 *
 *   dead-citation      names a file that no longer exists — cannot be true of this repository.
 *   stale-citation     names code that changed after the finding was written, so the claim was
 *                      made about a file that is no longer there in that form. NOT a judgement
 *                      that the concern was wrong: it is regenerable, and re-running the review
 *                      on the current tree is the correct way to re-raise it.
 *   settled-lookup     a deterministic check filed as a question — "is `urn:kabase:` a typo?" —
 *                      where the script that asked had already run the check and knew the answer.
 *
 * Everything else is kept. Judgement-bearing proposals, questions with a real open decision, and
 * anything this tool cannot confidently classify all stay: the failure mode to avoid is quietly
 * deleting a real finding, so an unrecognized row is always retained.
 *
 * SAFE BY DEFAULT: dry-run unless --apply, and --apply backs the queue up first.
 *
 *   npx tsx scripts/offline/queue-clean.ts                 dry-run: what would go, and why
 *   npx tsx scripts/offline/queue-clean.ts --apply         back up, then remove
 *   npx tsx scripts/offline/queue-clean.ts --keep-stale    remove only dead + settled lookups
 */
import { copyFileSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { QUEUE_PATH, transactPendingQueue } from './pending-queue.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

const APPLY = process.argv.includes('--apply');
const KEEP_STALE = process.argv.includes('--keep-stale');

type Reason = 'dead-citation' | 'stale-citation' | 'settled-lookup';

function git(args: string[]): string {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim(); }
  catch { return ''; }
}

const dirty = new Set(
  git(['status', '--porcelain']).split('\n').map((l) => l.slice(3).trim()).filter(Boolean),
);

const lineCache = new Map<string, number>();
const lineCount = (f: string) => {
  if (!lineCache.has(f)) {
    try { lineCache.set(f, readFileSync(f, 'utf8').split('\n').length); } catch { lineCache.set(f, 0); }
  }
  return lineCache.get(f)!;
};

const commitCache = new Map<string, string>();
const lastCommit = (f: string) => {
  if (!commitCache.has(f)) commitCache.set(f, git(['log', '-1', '--format=%cI', '--', f]));
  return commitCache.get(f)!;
};

/** `path/to/file.ts:123` — the last citation in the text, matching queue-validate.ts. */
function citation(text: string): { file: string; line: number } | undefined {
  const all = [...text.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|svelte|js|mjs|json|ttl|sh)):(\d+)/g)];
  const m = all[all.length - 1];
  return m ? { file: m[1], line: Number(m[2]) } : undefined;
}

/**
 * Deterministic checks that were queued as questions. Each is a lookup whose answer the producing
 * script already held; the producers are fixed, but rows queued before that stay behind.
 */
function isSettledLookup(r: Record<string, unknown>): boolean {
  if (r.agent !== 'offline:alignment-sweep') return false;
  const partial = r.object == null || r.object === '';
  return r.type === 'question' && partial;
}

function classify(r: Record<string, unknown>): Reason | undefined {
  if (isSettledLookup(r)) return 'settled-lookup';

  if (!/code-review/.test(String(r.agent ?? ''))) return undefined;
  const cite = citation(String(r.question ?? r.note ?? ''));
  if (!cite) return undefined;                       // no citation to check — keep
  if (!existsSync(cite.file)) return 'dead-citation';
  if (lineCount(cite.file) < cite.line) return 'dead-citation';
  if (KEEP_STALE) return undefined;

  const addedAt = typeof r.addedAt === 'string' ? r.addedAt : undefined;
  if (dirty.has(cite.file)) return 'stale-citation';
  const committed = lastCommit(cite.file);
  if (addedAt && committed && committed > addedAt) return 'stale-citation';
  return undefined;                                   // live — keep
}

if (APPLY) copyFileSync(QUEUE_PATH, `${QUEUE_PATH}.clean-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);

const counts = new Map<Reason, number>();
const byAgent = new Map<string, number>();
let total = 0, kept = 0;

const result = transactPendingQueue(QUEUE_PATH, (cur) => {
  const keep: string[] = [];
  for (const line of cur.split('\n')) {
    if (!line.trim()) continue;
    total++;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { keep.push(line); kept++; continue; }  // unreadable → retained

    const reason = classify(row);
    if (!reason) { keep.push(line); kept++; continue; }
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
    const a = String(row.agent ?? '?');
    byAgent.set(a, (byAgent.get(a) ?? 0) + 1);
  }
  const content = keep.length ? keep.join('\n') + '\n' : '';
  return APPLY ? { content, result: total - kept } : { result: total - kept };
});

const WHY: Record<Reason, string> = {
  'dead-citation': 'names a file or line that no longer exists',
  'stale-citation': 'names code that changed after the finding — re-run the review to re-raise',
  'settled-lookup': 'a deterministic check filed as a question it had already answered',
};

console.log(`\n${B}Queue clean${X} ${D}${QUEUE_PATH}${X}`);
console.log(`${D}${'─'.repeat(76)}${X}`);
console.log(`  ${String(total).padStart(4)} rows`);
console.log(`  ${G}${String(kept).padStart(4)} kept${X} ${D}— decisions, open questions, and anything unclassifiable${X}`);
console.log(`  ${Y}${String(result).padStart(4)} not decisions${X}\n`);
for (const [reason, n] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${R}${String(n).padStart(4)} ${reason.padEnd(16)}${X} ${D}${WHY[reason]}${X}`);
}
if (byAgent.size) {
  console.log(`\n${D}  by producer:${X}`);
  for (const [a, n] of [...byAgent].sort((x, y) => y[1] - x[1])) console.log(`    ${String(n).padStart(4)}  ${a}`);
}

console.log(`\n${D}${'─'.repeat(76)}${X}`);
if (APPLY) {
  console.log(`${G}✓ removed ${result} row(s)${X} — ${kept} left, every one of them something you can settle.`);
  console.log(`${D}  Stale code findings are regenerable: re-run code-review on the current tree.${X}`);
} else {
  console.log(`${Y}dry-run — nothing written.${X} Re-run with ${B}--apply${X}.`);
}
console.log('');
