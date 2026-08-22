#!/usr/bin/env npx tsx
/**
 * Validate pending code-review findings against the repository they describe (F74.3, script tier).
 *
 * WHY. Two thirds of the queue is machine-generated code review, and none of it has ever been ruled
 * on. Handing a human 200+ findings to read one at a time is the expensive way to discover that most
 * of them no longer describe the code. A local review names a FILE and a LINE, and both claims are
 * checkable by a rule — so the rule should check them, for free, before a person spends judgement.
 *
 * Every finding is classified by evidence, never by opinion about whether it is a good finding:
 *
 *   dead   the file it describes no longer exists. The finding cannot be true of this repository.
 *   moved  the file exists but is shorter than the cited line. That line reference is gone.
 *   stale  the file changed after the finding was written, so its line reference is unreliable and
 *          the code it judged is not the code that is there now.
 *   live   the file has not changed since the finding was written. It still describes the current
 *          code, and is worth a human read.
 *
 * WHAT THIS DOES NOT DO. It never decides whether a finding is CORRECT — only whether it still
 * refers to anything real. A `live` finding is not endorsed; a `stale` one is not wrong. Staleness
 * is grounds for re-running the review, not for assuming the concern was invalid. Nothing is
 * written, settled, or deleted: this reads the queue and reports.
 *
 *   npx tsx scripts/offline/queue-validate.ts              classify every code-review finding
 *   npx tsx scripts/offline/queue-validate.ts --show live  list the findings in one class
 *   npx tsx scripts/offline/queue-validate.ts --json       machine-readable
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { QUEUE_PATH } from './pending-queue.js';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', C = '\x1b[36m', X = '\x1b[0m';

const JSON_OUT = process.argv.includes('--json');
const SHOW = (() => {
  const i = process.argv.indexOf('--show');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

type Verdict = 'dead' | 'moved' | 'stale' | 'live' | 'unparsed';

/** `path/to/file.ts:123` anywhere in the finding text. Repo-relative paths only. */
function citation(text: string): { file: string; line: number } | undefined {
  // Prefer the LAST citation: these read "[local review] <file>: <file>:<line> — <claim>".
  const matches = [...text.matchAll(/([A-Za-z0-9_./-]+\.(?:ts|svelte|js|mjs|json|ttl|sh)):(\d+)/g)];
  const m = matches[matches.length - 1];
  return m ? { file: m[1], line: Number(m[2]) } : undefined;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch {
    return '';
  }
}

/** Files with uncommitted modifications — they changed since ANY past finding. */
const dirty = new Set(
  git(['status', '--porcelain'])
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean),
);

const lineCache = new Map<string, number>();
function lineCount(file: string): number {
  if (!lineCache.has(file)) {
    try {
      lineCache.set(file, readFileSync(file, 'utf8').split('\n').length);
    } catch {
      lineCache.set(file, 0);
    }
  }
  return lineCache.get(file)!;
}

const changedCache = new Map<string, string>();
/** ISO date of the last commit touching `file`, or '' if never committed. */
function lastCommit(file: string): string {
  if (!changedCache.has(file)) {
    changedCache.set(file, git(['log', '-1', '--format=%cI', '--', file]));
  }
  return changedCache.get(file)!;
}

const rows = readFileSync(QUEUE_PATH, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => {
    try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; }
  })
  .filter((r): r is Record<string, unknown> => !!r)
  .filter((r) => /code-review/.test(String(r.agent ?? '')));

type Result = { verdict: Verdict; file?: string; line?: number; addedAt?: string; text: string };
const results: Result[] = rows.map((r) => {
  const text = String(r.question ?? r.note ?? '');
  const addedAt = typeof r.addedAt === 'string' ? r.addedAt : undefined;
  const cite = citation(text);
  if (!cite) return { verdict: 'unparsed', addedAt, text };

  if (!existsSync(cite.file)) return { verdict: 'dead', ...cite, addedAt, text };
  if (lineCount(cite.file) < cite.line) return { verdict: 'moved', ...cite, addedAt, text };

  if (dirty.has(cite.file)) return { verdict: 'stale', ...cite, addedAt, text };
  const committed = lastCommit(cite.file);
  if (addedAt && committed && committed > addedAt) return { verdict: 'stale', ...cite, addedAt, text };

  return { verdict: 'live', ...cite, addedAt, text };
});

if (JSON_OUT) {
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

const by = (v: Verdict) => results.filter((r) => r.verdict === v);
const pct = (n: number) => `${Math.round((n / results.length) * 100)}%`;

console.log(`\n${B}Code-review finding validation${X} ${D}${results.length} findings${X}`);
console.log(`${D}${'─'.repeat(76)}${X}`);
const legend: [Verdict, string, string][] = [
  ['dead',  R, 'file no longer exists — cannot be true of this repo'],
  ['moved', R, 'file is shorter than the cited line — that line is gone'],
  ['stale', Y, 'file changed after the finding — line ref unreliable'],
  ['live',  G, 'file unchanged since the finding — still describes current code'],
  ['unparsed', D, 'no file:line citation found'],
];
for (const [v, color, why] of legend) {
  const n = by(v).length;
  if (!n) continue;
  console.log(`  ${color}${String(n).padStart(4)} ${v.padEnd(9)}${X} ${D}${pct(n)}  ${why}${X}`);
}

const actionable = by('live').length;
console.log(`\n${D}${'─'.repeat(76)}${X}`);
console.log(`${B}${actionable}${X} of ${results.length} findings still describe current code ${D}(${pct(actionable)})${X}`);
console.log(`${D}The rest reference code that has since changed or gone. Staleness is grounds for`);
console.log(`re-running the review on the current tree, not for assuming the concern was wrong.${X}`);

if (SHOW) {
  const picked = by(SHOW as Verdict);
  console.log(`\n${B}${SHOW}${X} ${D}(${picked.length})${X}`);
  const byFile = new Map<string, Result[]>();
  for (const r of picked) {
    const k = r.file ?? '(no citation)';
    byFile.set(k, [...(byFile.get(k) ?? []), r]);
  }
  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n  ${C}${file}${X} ${D}(${list.length})${X}`);
    for (const r of list) {
      const claim = r.text.replace(/^\[local review\][^—]*—\s*/, '').trim();
      console.log(`    ${D}:${String(r.line ?? '?').padEnd(5)}${X} ${claim.slice(0, 150)}`);
    }
  }
}
console.log('');
