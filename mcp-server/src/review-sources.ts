/**
 * WHERE THE REVIEW TOOLS LOOK FOR PROPOSALS, AND WHERE THEIR VERDICTS GO.
 *
 * THE FINDING, 2026-10-08. There were two review queues that never met. Every offline job writes
 * to <workspace>/knowledge.pending.jsonl (rows carry their own `kb`), and the browser app drains
 * that file and the sibling <workspace>/knowledge.decisions.jsonl. The MCP review tools, though,
 * read only per-graph <mcp-workspace>/kbs/<graph>/pending.jsonl — so on that day they reported
 * 85 rows while the jobs' queue held about 1,270, `kb_review_next --agent code-review` matched
 * nothing, and a reviewer built on those tools could neither see nor settle any job's findings.
 *
 * So there are two KINDS of source, and a verdict goes to the journal beside the queue the
 * decision's rows came from:
 *
 *  - 'workspace': <queue workspace>/knowledge.pending.jsonl. Its journal,
 *    <queue workspace>/knowledge.decisions.jsonl, is the file `drainWorkspaceDecisions`
 *    (src/lib/stores/workspace.svelte.ts, WORKSPACE_DECISIONS_FILE) reads. A verdict journalled
 *    here is applied by the app on its next drain.
 *  - 'graph': kbs/<graph>/pending.jsonl with decisions.jsonl beside it. THE APP DOES NOT READ
 *    THESE JOURNALS (drainWorkspaceDecisions only opens the workspace-root file), so a verdict
 *    recorded against a per-graph queue is durable and hides the decision from these tools, but
 *    nothing applies it. That was already true before this change; it is stated here rather than
 *    fixed here.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readPendingRows, type PendingRow } from './review-links.js';
import { groupDecisions, normalizeKb, rowId, settledIds, type Arity, type Decision } from './review-session.js';

export const WORKSPACE_QUEUE_FILE = 'knowledge.pending.jsonl';

export interface QueueSource {
  kind: 'graph' | 'workspace';
  /** The pending queue file. */
  queue: string;
  /** The verdict journal beside it. */
  decisions: string;
}

/** `…pending.jsonl` -> `…decisions.jsonl`, for both `pending.jsonl` and `knowledge.pending.jsonl`. */
export function decisionsFileFor(pendingFile: string): string {
  return pendingFile.replace(/pending\.jsonl$/, 'decisions.jsonl');
}

/**
 * The directory holding the jobs' queue: explicit flag, then env, then `reckons-workspace/`
 * under `cwd` (scripts/mcp-server.sh runs from the repo root). Returns null when none exists,
 * so a missing directory narrows the review to the per-graph files instead of failing.
 */
export function resolveQueueWorkspace(opts: { flag?: string; env?: string; cwd: string }): string | null {
  const explicit = opts.flag?.trim() || opts.env?.trim();
  if (explicit) return resolve(opts.cwd, explicit);
  const fallback = resolve(opts.cwd, 'reckons-workspace');
  return existsSync(fallback) ? fallback : null;
}

/** Per-graph queue files first, then the workspace queue (when that file exists). */
export function buildSources(graphQueues: string[], queueWorkspace: string | null): QueueSource[] {
  const sources: QueueSource[] = graphQueues.map((queue) => ({ kind: 'graph', queue, decisions: decisionsFileFor(queue) }));
  if (queueWorkspace) {
    const queue = join(queueWorkspace, WORKSPACE_QUEUE_FILE);
    if (existsSync(queue)) sources.push({ kind: 'workspace', queue, decisions: decisionsFileFor(queue) });
  }
  return sources;
}

export interface ReviewState {
  decisions: Decision[];
  sources: QueueSource[];
  totalRows: number;
  settled: number;
}

/**
 * Every open decision across all sources. A row present in two sources (same rowId) counts once,
 * so a proposal mirrored into both places is not a double witness. A decision is settled if ANY
 * source's journal settles it.
 */
export function loadReviewState(
  sources: QueueSource[], arity: ReadonlyMap<string, Arity>, kbFilter?: string,
): ReviewState {
  const wanted = kbFilter ? normalizeKb(kbFilter) : null;
  const seen = new Set<string>();
  const rows: PendingRow[] = [];
  for (const s of sources) {
    for (const r of readPendingRows(s.queue)) {
      // Workspace rows name their graph themselves; per-graph files were filtered by folder.
      if (wanted && s.kind === 'workspace' && normalizeKb((r as { kb?: unknown }).kb) !== wanted) continue;
      const id = rowId(r);
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(r);
    }
  }
  const settled = new Set<string>();
  for (const s of sources) for (const id of settledIds(s.decisions)) settled.add(id);
  const all = groupDecisions(rows, arity);
  const decisions = all.filter((d) => !settled.has(d.id));
  return { decisions, sources, totalRows: rows.length, settled: all.length - decisions.length };
}

/** The journals a verdict on `d` must be written to: one per source holding any of its rows. */
export function journalsFor(d: Decision, sources: QueueSource[]): string[] {
  return sources
    .filter((s) => readPendingRows(s.queue).some((r) => d.rowIds.includes(rowId(r))))
    .map((s) => s.decisions);
}
