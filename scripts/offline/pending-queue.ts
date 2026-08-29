/**
 * THE SHARED QUEUE-APPEND PATH — one place that decides whether a finding is new.
 *
 * WHY THIS EXISTS. Twenty files write to reckons-workspace/knowledge.pending.jsonl and each one
 * decided for itself whether it was repeating something. Most decided nothing at all. By
 * 2026-08-15 the queue held 904 entries that had never been ruled on, and the entry reported the
 * most times — FIFTY-NINE — was a real, unfixed defect that had been buried in its own repeats.
 * The noise did not merely cost triage time; it hid the thing worth acting on.
 *
 * The two jobs that DID guard (graph-lint, history-lessons) used a substring test over the whole
 * file:
 *
 *     if (existing.includes(JSON.stringify(question).slice(1, -1))) continue;
 *
 * which is wrong in both directions. It ignores subject and predicate entirely, so the same
 * sentence about a DIFFERENT entity is treated as already-queued and silently dropped — that is
 * lost signal, not saved noise. And it matches on substrings, so a short finding that happens to
 * be contained in a longer one is discarded too.
 *
 * TWO KINDS OF REPEAT, AND THEY NEED DIFFERENT ANSWERS.
 *
 *   DUPLICATE      — the identical finding, already queued. Skip it.
 *   SUPERSEDED     — a job that RE-DERIVES its findings every run has produced a fresh answer to
 *                    the same question. The old one is not a duplicate, it is a stale computation,
 *                    and keeping it means the queue accumulates history nobody asked for.
 *                    branch-align had run 14 times and left 345 proposals that reduce to 55.
 *
 * Superseding only applies to jobs that genuinely recompute, and those are named explicitly rather
 * than inferred. A one-time observation written by a human or by Opus is superseded by nothing,
 * and treating age as staleness would silently delete the most considered entries in the queue.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile, withFileLock } from '../agent/state-file.js';
import { readTextOr } from '../lib/read-file.js';

const repositoryUrl = new URL('../..', import.meta.url);
// Vitest's transformed module URL is HTTP-shaped rather than file:, even though the test still
// runs in Node from the repository root. Do not let computing an overridable default queue path
// make every pure queue test fail during module import.
const repositoryRoot = repositoryUrl.protocol === 'file:' ? fileURLToPath(repositoryUrl) : process.cwd();
export const QUEUE_PATH = join(repositoryRoot, 'reckons-workspace/knowledge.pending.jsonl');

export type Finding = {
  subject: string;
  predicate: string;
  /** Destination graph. Repository audit jobs default to the roadmap graph. */
  kb?: string;
  /** The human-readable finding. Jobs use `question`; proposed triples use `object` + `note`. */
  question?: string;
  object?: string;
  note?: string;
  type?: 'observation' | 'question' | 'suggestion' | 'status-update' | 'drift-warning';
  /** `medium` is accepted for legacy producers; the app normalizes it to `normal`. */
  priority?: 'low' | 'normal' | 'medium' | 'high';
  /** Work held by a question. Block order is not part of identity. */
  blocks?: string | string[];
  [k: string]: unknown;
};

export type PendingQueueTransaction<T> = {
  /** Omit to leave the queue byte-for-byte unchanged. */
  content?: string;
  result: T;
};

/**
 * The one host-side read/modify/write boundary for a pending JSONL file.
 *
 * Every Node producer and rewriter of the same path must participate in this advisory lock. The
 * browser File System Access API cannot hold Linux `flock`, so `withFileLock` publishes a leased
 * `.lock.active` marker while this transaction runs. `workspace.svelte.ts` observes that marker
 * before draining. This narrows the cross-runtime race but is still optimistic concurrency: the
 * browser cannot atomically acquire the kernel lock.
 */
export function transactPendingQueue<T>(
  queuePath: string,
  action: (current: string) => PendingQueueTransaction<T>,
): T {
  return withFileLock(`${queuePath}.lock`, () => {
    const current = readTextOr(queuePath, '');
    const transaction = action(current);
    if (transaction.content !== undefined && transaction.content !== current) {
      atomicWriteFile(queuePath, transaction.content);
    }
    return transaction.result;
  });
}

/**
 * Jobs whose findings are recomputed from scratch on every run, so only the newest run describes
 * the world as it currently is.
 *
 * Deliberately NOT including `claude-code`, `opus:*` or `council:*`. Nothing recomputes those.
 */
export const RECOMPUTABLE_AGENTS = new Set([
  'offline:branch-align',
  'offline:alignment-sweep',
  'offline:graph-lint',
  'offline:server-health',
  'offline:integration-health',
  'offline:competitor-scan',
  'offline:proposal-yield',
  'offline:shacl-validate',
  'offline:scope-check',
  'button-crawl',
]);

/**
 * Identity of a finding: destination graph + subject + predicate + blockers + readable text.
 *
 * Exported because queue-dedupe.ts MUST use the same rule. If the guard and the cleaner disagreed,
 * the cleaner would delete entries the guard considers distinct and the guard would re-add entries
 * the cleaner just removed — a queue that churns forever and is never right.
 *
 * The timestamp is deliberately excluded: a re-queued finding differs from its original only by
 * addedAt, so any key including it would call every repeat unique.
 */
export function findingIdentity(r: {
  subject?: string;
  predicate?: string;
  kb?: unknown;
  blocks?: unknown;
  question?: unknown;
  object?: unknown;
}): string {
  const text = String(r.question ?? r.object ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const kb = normalizeFindingKb(r.kb);
  const blocks = normalizeFindingBlocks(r.blocks);
  return `${kb}|${String(r.subject ?? '').trim()}|${String(r.predicate ?? '').trim()}|${JSON.stringify(blocks)}|${text}`;
}

/** Same spelling rule as app-side pending routing, with `roadmap` as the repository legacy default. */
export function normalizeFindingKb(value: unknown): string {
  return String(value ?? 'roadmap')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-');
}

/** A question blocking A+B is the same question regardless of the order producers supplied. */
export function normalizeFindingBlocks(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))].sort();
}

export type QueueResult = { queued: number; skipped: number; superseded: number };

/**
 * Append findings that are actually new, and drop what a fresh run has replaced.
 *
 * Rewrites the file when superseding (it has to remove lines), appends otherwise. Both paths are
 * a single write, so a job that crashes mid-run leaves the queue readable rather than truncated.
 */
export function queueFindings(
  findings: Finding[],
  opts: { agent: string; path?: string; recomputes?: boolean; kb?: string },
): QueueResult {
  const path = opts.path ?? QUEUE_PATH;
  return transactPendingQueue(path, (current) => queueFindingsLocked(findings, opts, current));
}

function queueFindingsLocked(
  findings: Finding[],
  opts: { agent: string; path?: string; recomputes?: boolean; kb?: string },
  existingRaw: string,
): PendingQueueTransaction<QueueResult> {
  const agent = opts.agent;
  const recomputes = opts.recomputes ?? RECOMPUTABLE_AGENTS.has(agent.split(' ')[0]);
  const now = new Date().toISOString();

  const existingLines = existingRaw.split('\n').filter((l) => l.trim());

  const parsed: { raw: string; row: Record<string, unknown> }[] = [];
  for (const raw of existingLines) {
    try {
      parsed.push({ raw, row: JSON.parse(raw) as Record<string, unknown> });
    } catch {
      // A line we cannot parse is left exactly as it is. Rewriting the queue must never be a way
      // to quietly lose somebody's hand-written entry because it had a stray character.
      parsed.push({ raw, row: {} });
    }
  }

  const seen = new Set(parsed.map((p) => findingIdentity(p.row as never)));

  // These jobs inspect this repository's implementation and roadmap, so `roadmap` is the safe
  // default. A producer that targets another graph must say so explicitly. Leaving `kb` absent
  // used to mean "whatever graph the browser has open", which is not routing at all.
  const targetKb = opts.kb ?? 'roadmap';
  const rows = findings.map((f) => ({
    ...f,
    kb: f.kb ?? targetKb,
    agent,
    addedAt: now,
    addedByMcp: true,
  }));

  let skipped = 0;
  const incoming = new Set<string>();
  const uniqueRows = rows.filter((r) => {
    const id = findingIdentity(r);
    if (incoming.has(id)) {
      skipped++;
      return false;
    }
    incoming.add(id);
    return true;
  });

  const fresh = uniqueRows.filter((r) => {
    if (seen.has(findingIdentity(r))) {
      skipped++;
      return false;
    }
    seen.add(findingIdentity(r));
    return true;
  });

  let superseded = 0;
  if (recomputes) {
    // THIS RUN IS THE COMPLETE ANSWER FROM THIS JOB, so everything it said before is replaced —
    // not merged. That is what lets a FIXED problem disappear on its own: the job simply stops
    // reporting it and the entry goes, instead of lingering until a human notices it is no longer
    // true. Merging would mean the queue only ever grows.
    //
    // THE HAZARD, STATED: a job that crashes half way through would replace fifty findings with
    // the two it managed to emit. So `recomputes` is a promise that this call carries a COMPLETE
    // sweep, and a job that bailed early must not make it.
    const runKbs = new Set((uniqueRows.length ? uniqueRows : [{ kb: targetKb }]).map((row) => normalizeFindingKb(row.kb)));
    const mine = (row: Record<string, unknown>) =>
      String(row.agent ?? '').split(' ')[0] === agent.split(' ')[0] &&
      runKbs.has(normalizeFindingKb(row.kb));

    // Carry the ORIGINAL first-seen date across the rewrite. Stamping today's date on a finding
    // that has been true since July would erase how long it has been open — which is exactly the
    // information that makes an unruled queue visible as a problem.
    const firstSeen = new Map<string, unknown>();
    for (const { row } of parsed) {
      if (mine(row) && row.addedAt) firstSeen.set(findingIdentity(row as never), row.addedAt);
    }

    const survivors = parsed.filter(({ row }) => {
      if (!mine(row)) return true; // other jobs' findings are untouched
      superseded++;
      return false;
    });

    const current = uniqueRows.map((r) => JSON.stringify({ ...r, addedAt: firstSeen.get(findingIdentity(r)) ?? r.addedAt }));
    const out = [...survivors.map((s) => s.raw), ...current];
    // Of the prior entries removed, the ones this run repeats are not really "superseded" — they
    // are still true. Report only the ones that genuinely went away.
    const stillTrue = uniqueRows.filter((r) => firstSeen.has(findingIdentity(r))).length;
    return {
      content: out.join('\n') + (out.length ? '\n' : ''),
      result: { queued: uniqueRows.length, skipped, superseded: Math.max(0, superseded - stillTrue) },
    };
  }

  if (fresh.length) {
    return {
      content: existingRaw + (existingRaw && !existingRaw.endsWith('\n') ? '\n' : '') +
        fresh.map((r) => JSON.stringify(r)).join('\n') + '\n',
      result: { queued: fresh.length, skipped, superseded: 0 },
    };
  }
  return { result: { queued: 0, skipped, superseded: 0 } };
}
