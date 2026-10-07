/**
 * CATCH-UP SCHEDULES — the anacron model for the session worker (F74.7, F81).
 *
 * Matt, 2026-09-30: "We need a regular check of voice notes, and other tasks that never seem to work
 * from cron because my machine was off." and "Maintenance, full alignment checks, and many other
 * tasks can be regularly queued."
 *
 * A wall-clock cron entry that fires while the machine is off is simply lost. Here each recurring
 * job carries only an INTERVAL; whenever the session is active the worker asks "when did this last
 * SUCCEED?" and enqueues it if that is older than the interval. A job overdue by three periods runs
 * ONCE, never three times, and a job already queued or running is never enqueued again.
 *
 * ONE SOURCE, NOT TWO: the definitions are the ktype:Schedule entities in
 * reckons-workspace/schedules.ttl that scripts/agent/schedule.ts already reads (kpred:every,
 * kpred:command), plus per-machine overrides from the private device.ttl (device-config.ts). This file
 * only reads those graphs; it adds no second format. Last-success comes from
 * the worker's own queue.done.jsonl and from schedule.ts's schedules.state.ttl, so a run by either
 * trigger counts.
 *
 * WEAKNESS, said out loud: schedule.ts (cron) and this worker do not share a lock, so on a machine
 * that is on with both installed an interval can fire once from each. Both are idempotent drains
 * (notes-pull is at-least-once by design) but it is wasted work; entities marked
 * kpred:harness "session-worker" are skipped by schedule.ts to avoid exactly that.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Parser } from 'n3';
import { compileSchedules, loadDeviceConfig, type CompiledSchedule } from './device-config.js';
import { jobKey, type DoneJob, type QueueJob, newJob } from './session-queue.js';

const KPRED = 'urn:kbase:predicate/';

/** "15m" | "6h" | "1d" | "1w" -> ms; anything else is null (the schedule is then never due). Pure. */
export function parseEvery(v: string | undefined): number | null {
  const m = v?.trim().match(/^(\d+)\s*(m|h|d|w)$/i);
  if (!m) return null;
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2].toLowerCase() as 'm' | 'h' | 'd' | 'w'];
  return Number(m[1]) * unit;
}

export type Recurring = { name: string; label: string; argv: string[]; cwd: string; every: string; everyMs: number; network?: boolean; tier?: string;
  /** false for tier=script: the GPU gate does not apply. Anything not declared script is treated as GPU. */
  gpu: boolean };

/** `sched:<id>` — the queue name of a recurring job, so its history is findable by name. */
export const scheduleName = (iri: string): string => `sched:${iri.split('/').pop()}`;

type Quad = { subject: { value: string }; predicate: { value: string }; object: { value: string } };

/** Recurring jobs from compiled schedule statements; an unparseable interval is dropped (never due). Pure. */
export function toRecurring(compiled: CompiledSchedule[], cwd: string): Recurring[] {
  const out: Recurring[] = [];
  for (const c of compiled) {
    const everyMs = parseEvery(c.every);
    if (everyMs === null) continue;
    // The command is a shell string in the graph (as schedule.ts runs it), so the argv is `bash -c <command>`;
    // the graph is LOCAL and named here, never imported.
    out.push({ name: scheduleName(c.iri), label: c.label, argv: ['/bin/bash', '-c', c.command], cwd, every: c.every, everyMs,
      ...(c.network ? { network: true } : {}), ...(c.tier ? { tier: c.tier } : {}), gpu: c.tier !== 'script' });
  }
  return out;
}

/** Recurring jobs from schedule graphs (defaults first, device overrides last), for `host`. Pure. */
export const parseSchedules = (sources: string | string[], cwd: string, host: string = os.hostname()): Recurring[] =>
  toRecurring(compileSchedules(Array.isArray(sources) ? sources : [sources], host), cwd);

/** last-run (epoch ms) of schedules whose last-outcome is ok, from schedule.ts's state graph. Pure. */
export function parseStateSuccesses(stateTtl: string): Record<string, number> {
  const quads = new Parser().parse(stateTtl) as Quad[];
  const out: Record<string, number> = {};
  for (const q of quads) {
    if (q.predicate.value !== `${KPRED}last-run`) continue;
    const ok = quads.some((o) => o.subject.value === q.subject.value && o.predicate.value === `${KPRED}last-outcome` && o.object.value === 'ok');
    const t = Number(q.object.value);
    if (ok && Number.isFinite(t)) out[scheduleName(q.subject.value)] = t;
  }
  return out;
}

/** Latest PASSED finish per job name from the worker's done log. Pure. */
export function doneSuccesses(done: DoneJob[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of done) {
    if (d.outcome !== 'passed') continue;
    const t = Date.parse(d.finishedAt);
    if (Number.isFinite(t) && t > (out[d.name] ?? 0)) out[d.name] = t;
  }
  return out;
}

export const mergeSuccesses = (...all: Record<string, number>[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of all) for (const [k, v] of Object.entries(r)) if (v > (out[k] ?? 0)) out[k] = v;
  return out;
};

export type Due = {
  job: Recurring;
  due: boolean;
  /** ms past its due moment (>= 0 when due); undefined when it has never succeeded. */
  overdueMs?: number;
  /** ms until due (> 0) when not yet due. */
  dueInMs?: number;
  neverRun: boolean;
  level: 'ok' | 'warn' | 'bad';
};

/**
 * Due-ness from the last SUCCESS. Never run counts as due. Level: yellow once overdue by more than
 * one period, red by more than three; never-run is yellow (unknown, not an alarm). Pure.
 */
export function dueStatus(job: Recurring, lastSuccessMs: number | undefined, nowMs: number): Due {
  if (lastSuccessMs === undefined) return { job, due: true, neverRun: true, level: 'warn' };
  const dueAt = lastSuccessMs + job.everyMs;
  if (nowMs < dueAt) return { job, due: false, dueInMs: dueAt - nowMs, neverRun: false, level: 'ok' };
  const overdueMs = nowMs - dueAt;
  return { job, due: true, overdueMs, neverRun: false, level: overdueMs > 3 * job.everyMs ? 'bad' : overdueMs > job.everyMs ? 'warn' : 'ok' };
}

export const dueAll = (jobs: Recurring[], successes: Record<string, number>, nowMs: number): Due[] =>
  jobs.map((j) => dueStatus(j, successes[j.name], nowMs));

/**
 * The queue entries to add: each due job ONCE, however many periods overdue, unless a job of that
 * name+cwd is already queued or is the one running now. Pure.
 */
export function selectDue(statuses: Due[], queued: QueueJob[], runningName?: string, priority = 5, held: ReadonlySet<string> | ReadonlyMap<string, string> = new Set()): QueueJob[] {
  const have = new Set(queued.map(jobKey));
  const out: QueueJob[] = [];
  for (const s of statuses) {
    if (!s.due || s.job.name === runningName || held.has(s.job.name)) continue;
    const j = newJob(s.job.name, s.job.cwd, s.job.argv, priority, s.job.gpu);
    if (have.has(jobKey(j))) continue;
    have.add(jobKey(j));
    out.push(j);
  }
  return out;
}

/** How long a schedule rests after a failed or refused attempt before it is queued again. */
export const RETRY_BACKOFF_MS = 30 * 60_000;

/**
 * Schedules that must NOT be re-queued this pass, with the reason. Pure.
 *
 * WHY. Only a success resets a schedule's clock, so a schedule that failed is still overdue on the
 * next pass and was queued again at once. With the breaker open, every attempt was refused in about
 * a second and re-queued: 8,719 refusals of sched:safety-attestation between 2026-10-07 02:56 and
 * 15:56 UTC. Two holds stop that:
 *   circuit open   held until the breaker is reset (job-watch --reset), however long that is;
 *   recent attempt the last attempt failed or was refused less than backoffMs ago.
 */
export function heldSchedules(done: DoneJob[], openCircuits: Record<string, unknown>, now: number, backoffMs = RETRY_BACKOFF_MS): Map<string, string> {
  const held = new Map<string, string>();
  for (const name of Object.keys(openCircuits)) {
    held.set(name, `circuit open; reset with: npx tsx scripts/agent/job-watch.ts --name=${name} --reset`);
  }
  const last = new Map<string, DoneJob>();
  for (const d of done) {
    const prev = last.get(d.name);
    if (!prev || Date.parse(d.finishedAt) > Date.parse(prev.finishedAt)) last.set(d.name, d);
  }
  for (const [name, d] of last) {
    if (held.has(name) || (d.outcome !== 'failed' && d.outcome !== 'refused')) continue;
    const age = now - Date.parse(d.finishedAt);
    if (age < backoffMs) held.set(name, `last attempt ${d.outcome} ${Math.max(1, Math.round(age / 60_000))} min ago; retrying after ${Math.round(backoffMs / 60_000)} min`);
  }
  return held;
}

const fmt = (ms: number): string => (ms >= 86_400_000 * 2 ? `${Math.round(ms / 86_400_000)}d` : ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`);

/** "notes-pull (overdue 2d)" / "describe (in 3h)" / "x (never run)". Pure. */
export function dueLabel(d: Due): string {
  const id = d.job.name.replace(/^sched:/, '');
  return d.neverRun ? `${id} (never run)` : d.due ? `${id} (${d.overdueMs! > 0 ? `overdue ${fmt(d.overdueMs!)}` : 'due now'})` : `${id} (in ${fmt(d.dueInMs!)})`;
}

// ── IO ─────────────────────────────────────────────────────────────────────

/** Definitions from the device config (cached by mtime); successes from the cron state graph. */
export function loadRecurring(root: string): { jobs: Recurring[]; successes: Record<string, number> } {
  const state = path.join(root, 'reckons-workspace', 'schedules.state.ttl');
  const jobs = toRecurring(loadDeviceConfig(root).schedules, root);
  let fromState: Record<string, number> = {};
  try { if (existsSync(state)) fromState = parseStateSuccesses(readFileSync(state, 'utf8')); } catch { /* unreadable state = no history */ }
  return { jobs, successes: fromState };
}
