/**
 * PROPOSAL TALLY — per producing agent: proposed, accepted, rejected, still open. Shared by
 * proposal-yield.ts (the report) and the session queue worker (back-pressure, F74.9), so the
 * number that holds a job and the number that reports it can never disagree.
 *
 * Two places a proposal can be:
 *   queued  a line in reckons-workspace/knowledge.pending.jsonl, never imported: open.
 *   graph   a reified statement in a workspace graph carrying kmeta:proposed-by; its kmeta:status
 *           says confirmed/refined (accepted), rejected, or anything else (open).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Parser, type Quad } from 'n3';
import { rowId } from '../../../mcp-server/src/review-session.js';

export type Tally = { proposed: number; accepted: number; rejected: number; open: number };
export const WORKSPACES = ['reckons-workspace/kbs', 'mcp-workspace/kbs'];
export const PENDING_FILE = 'reckons-workspace/knowledge.pending.jsonl';
export const DECISIONS_FILE = 'reckons-workspace/knowledge.decisions.jsonl';
const META = 'urn:kbase:meta/';

const bump = (m: Map<string, Tally>, agent: string): Tally => {
  if (!m.has(agent)) m.set(agent, { proposed: 0, accepted: 0, rejected: 0, open: 0 });
  return m.get(agent)!;
};

/**
 * Pure: pending-row id -> verdict, from the journal (knowledge.decisions.jsonl), for rows a
 * verdict has ruled on but the app has not yet drained out of the queue. Without this a row
 * rejected through the MCP review tools still counted as unreviewed, and back-pressure held a
 * producer whose whole backlog had been judged (2026-10-13: 58 extraction-score rows).
 *
 * Only accept/reject settle (as in settledIds); defer does not. A reject covers every row it names.
 * An ACCEPT naming more than one row covers NONE: accepting one claim of a group says nothing about
 * its siblings (the grouping bug, decision eecf9f37: one accept hid 101 docs-review rows).
 */
export function settledRows(decisionsText: string): Map<string, 'accept' | 'reject'> {
  const out = new Map<string, 'accept' | 'reject'>();
  for (const line of decisionsText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { verdict?: unknown; rows?: unknown };
      if ((v.verdict !== 'accept' && v.verdict !== 'reject') || !Array.isArray(v.rows)) continue;
      if (v.verdict === 'accept' && v.rows.length !== 1) continue;
      for (const r of v.rows) if (typeof r === 'string') out.set(r, v.verdict);
    } catch { /* a malformed journal line settles nothing */ }
  }
  return out;
}

/** Pure: queued lines. Returns the number of well-formed lines too (malformed ones are not proposals). */
export function tallyPending(text: string, into: Map<string, Tally> = new Map(), settled: ReadonlyMap<string, 'accept' | 'reject'> = new Map()): { tallies: Map<string, Tally>; queued: number } {
  let queued = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { agent?: unknown };
      queued++;
      // A hand-written or foreign line can carry any JSON here; only a string names an agent.
      const t = bump(into, typeof e.agent === 'string' && e.agent ? e.agent : '(unattributed)');
      t.proposed++;
      const verdict = settled.size ? settled.get(rowId(e as never)) : undefined;
      if (verdict === 'accept') t.accepted++;
      else if (verdict === 'reject') t.rejected++;
      else t.open++;
    } catch { /* a malformed line is not a proposal */ }
  }
  return { tallies: into, queued };
}

/** Pure: one graph's quads. Returns whether the graph carried any attribution. */
export function tallyGraph(quads: Quad[], into: Map<string, Tally> = new Map()): boolean {
  const status = new Map<string, string>();
  const agent = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value === META + 'status') status.set(q.subject.value, q.object.value);
    else if (q.predicate.value === META + 'proposed-by') agent.set(q.subject.value, q.object.value);
  }
  for (const [stmt, who] of agent) {
    const t = bump(into, who);
    t.proposed++;
    const s = status.get(stmt);
    if (s === 'confirmed' || s === 'refined') t.accepted++;
    else if (s === 'rejected') t.rejected++;
    else t.open++;
  }
  return agent.size > 0;
}

function ttlFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) ttlFiles(p, out);
    else if (name.endsWith('.ttl')) out.push(p);
  }
  return out;
}

/** Read everything under `root`. A graph that does not parse is graph-lint's problem: skipped. */
export function tallyWorkspace(root: string): { tallies: Map<string, Tally>; queued: number; annotatedFiles: number } {
  const tallies = new Map<string, Tally>();
  const pending = join(root, PENDING_FILE);
  const decisions = join(root, DECISIONS_FILE);
  const settled = existsSync(decisions) ? settledRows(readFileSync(decisions, 'utf8')) : new Map<string, 'accept' | 'reject'>();
  const { queued } = tallyPending(existsSync(pending) ? readFileSync(pending, 'utf8') : '', tallies, settled);
  let annotatedFiles = 0;
  for (const ws of WORKSPACES) {
    for (const file of ttlFiles(join(root, ws))) {
      let quads: Quad[];
      try { quads = new Parser().parse(readFileSync(file, 'utf8')); } catch { continue; }
      if (tallyGraph(quads, tallies)) annotatedFiles++;
    }
  }
  return { tallies, queued, annotatedFiles };
}

/**
 * The job a producing agent belongs to, so a schedule can be matched to its own proposals:
 * "offline:layer-classify (qwen3:32b)" and "offline:docs-expand:qwen3:32b" -> "layer-classify",
 * "docs-expand"; "stars-scan" -> "stars-scan". Pure.
 */
export const producerKey = (agent: string): string => agent.replace(/^offline:/, '').split(/[\s:(]/)[0];

/** Open proposals per producer key, summed over every agent label that maps to it. Pure. */
export function openByProducer(tallies: Map<string, Tally>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [agent, t] of tallies) {
    const k = producerKey(agent);
    out.set(k, (out.get(k) ?? 0) + t.open);
  }
  return out;
}
