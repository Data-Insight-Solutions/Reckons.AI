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

/** `deferred` counts rows a reviewer looked at and could not settle (a journalled defer). They stay in `open`, so back-pressure is unchanged. */
export type Tally = { proposed: number; accepted: number; rejected: number; open: number; deferred: number };
export const WORKSPACES = ['reckons-workspace/kbs', 'mcp-workspace/kbs'];
export const PENDING_FILE = 'reckons-workspace/knowledge.pending.jsonl';
export const DECISIONS_FILE = 'reckons-workspace/knowledge.decisions.jsonl';
const META = 'urn:kbase:meta/';

const bump = (m: Map<string, Tally>, agent: string): Tally => {
  if (!m.has(agent)) m.set(agent, { proposed: 0, accepted: 0, rejected: 0, open: 0, deferred: 0 });
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

/**
 * Pure: pending-row id -> a reviewer's defer, from the journal. A row deferred and later accepted or
 * rejected is no longer a defer (the settled verdict wins in tallyPending). Used only for DECIDABILITY
 * (F89.4.6): a defer says "I looked and could not settle it", which settledRows rightly ignores.
 */
export function deferredRows(decisionsText: string): Set<string> {
  const out = new Set<string>();
  for (const line of decisionsText.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as { verdict?: unknown; rows?: unknown };
      if (v.verdict !== 'defer' || !Array.isArray(v.rows)) continue;
      for (const r of v.rows) if (typeof r === 'string') out.add(r);
    } catch { /* a malformed journal line defers nothing */ }
  }
  return out;
}

/** Pure: queued lines. Returns the number of well-formed lines too (malformed ones are not proposals). */
export function tallyPending(text: string, into: Map<string, Tally> = new Map(), settled: ReadonlyMap<string, 'accept' | 'reject'> = new Map(), deferred: ReadonlySet<string> = new Set()): { tallies: Map<string, Tally>; queued: number } {
  let queued = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { agent?: unknown };
      queued++;
      // A hand-written or foreign line can carry any JSON here; only a string names an agent.
      const t = bump(into, typeof e.agent === 'string' && e.agent ? e.agent : '(unattributed)');
      t.proposed++;
      const id = settled.size || deferred.size ? rowId(e as never) : '';
      const verdict = settled.size ? settled.get(id) : undefined;
      if (verdict === 'accept') t.accepted++;
      else if (verdict === 'reject') t.rejected++;
      else {
        t.open++;
        if (deferred.has(id)) t.deferred++;
      }
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
  const journal = existsSync(decisions) ? readFileSync(decisions, 'utf8') : '';
  const { queued } = tallyPending(existsSync(pending) ? readFileSync(pending, 'utf8') : '', tallies, settledRows(journal), deferredRows(journal));
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

// ── PRODUCER STATE (F89.4.6) ─────────────────────────────────────────────────────────────
// Two numbers over the rows a reviewer has ruled on, then a state. Pure, so a fixture tests it.
//
// Built on the verdict journal as it is TODAY: kb:review-one-ledger (F89.4.2) is not built, so a
// row counts as ruled on only if it was accepted/rejected/deferred through the journal or sits in
// a graph with a kmeta:status. Graph rows cannot be deferred, so a producer that writes to graphs
// has no visible decidability loss. The sample gate (F89.4.5) is not built either: SAMPLING here
// is a label, it does not yet limit how many rows enter the queue.

export type ProducerState = 'sampling' | 'open' | 'held' | 'paused' | 'retired';
export type StateLimits = { minRuled: number; minYield: number; minDecidability: number; holdUnreviewed: number };
export const DEFAULT_STATE_LIMITS: StateLimits = { minRuled: 10, minYield: 0.3, minDecidability: 0.5, holdUnreviewed: 50 };

export type ProducerMeasure = {
  /** accepted + rejected + deferred */
  ruled: number;
  /** accepted over (accepted + rejected); null when neither exists */
  yield: number | null;
  /** (accepted + rejected) over ruled; null when nothing is ruled on */
  decidability: number | null;
  open: number;
};

/** Pure: sum the tallies of every agent label that maps to one producer key. */
export function measureProducers(tallies: Map<string, Tally>): Map<string, ProducerMeasure> {
  const sums = new Map<string, Tally>();
  for (const [agent, t] of tallies) {
    const k = producerKey(agent);
    const s = sums.get(k) ?? { proposed: 0, accepted: 0, rejected: 0, open: 0, deferred: 0 };
    s.proposed += t.proposed; s.accepted += t.accepted; s.rejected += t.rejected; s.open += t.open; s.deferred += t.deferred;
    sums.set(k, s);
  }
  const out = new Map<string, ProducerMeasure>();
  for (const [k, s] of sums) out.set(k, measureOf(s));
  return out;
}

export function measureOf(t: Tally): ProducerMeasure {
  const settled = t.accepted + t.rejected;
  const ruled = settled + t.deferred;
  return { ruled, yield: settled ? t.accepted / settled : null, decidability: ruled ? settled / ruled : null, open: t.open };
}

/**
 * Pure. The order matters: PAUSED (a measured verdict on the producer) outranks HELD (a pile nobody
 * read), which outranks SAMPLING (too few rulings to judge) — so a new job with 60 unreviewed rows is
 * held, not "sampling". `retired` is never returned: it is a person's verdict, read from a ledger
 * line, and no number moves a producer there.
 */
export function producerState(m: ProducerMeasure, limits: StateLimits = DEFAULT_STATE_LIMITS): { state: Exclude<ProducerState, 'retired'>; reason: string } {
  if (m.ruled >= limits.minRuled) {
    if (m.yield !== null && m.yield < limits.minYield) return { state: 'paused', reason: pausedReason(m, `yield ${m.yield.toFixed(2)} is under ${limits.minYield}`) };
    if (m.decidability !== null && m.decidability < limits.minDecidability) return { state: 'paused', reason: pausedReason(m, `decidability ${m.decidability.toFixed(2)} is under ${limits.minDecidability}`) };
  }
  if (m.open >= limits.holdUnreviewed) return { state: 'held', reason: `${m.open} unreviewed proposals (limit ${limits.holdUnreviewed}); review some to release it` };
  if (m.ruled < limits.minRuled) return { state: 'sampling', reason: `${m.ruled} of ${limits.minRuled} rows ruled on` };
  return { state: 'open', reason: 'yield and decidability above the limits' };
}

const num = (v: number | null): string => (v === null ? 'n/a' : v.toFixed(2));
const pausedReason = (m: ProducerMeasure, why: string): string =>
  `${why} (yield ${num(m.yield)}, decidability ${num(m.decidability)}, ${m.ruled} ruled on); ways out: give the job the fact it cannot tell, demote it to a report, or retire it (a person's call)`;

/**
 * Pure: the schedules a PAUSED producer should not run, in the same shape as backlogHolds
 * (schedule name -> reason). `retiredProducers` come from a recorded verdict by a person; nothing here sets it.
 */
export function pausedProducers(tallies: Map<string, Tally>, limits: StateLimits = DEFAULT_STATE_LIMITS): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, m] of measureProducers(tallies)) {
    const s = producerState(m, limits);
    if (s.state === 'paused') out.set(k, s.reason);
  }
  return out;
}
