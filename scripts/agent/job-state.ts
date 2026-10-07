/**
 * JOB STATE — the circuit breaker, the "what is running now" file, and the readers agent:watch uses (F74.7, F89).
 *
 * WHY. Matt, 2026-09-30: "Retry count of job would be critical to stop a failing loop taking up
 * compute." A watched job that fails the same way over and over is a loop burning a GPU or a CI
 * minute to learn nothing. This is a SCRIPT-tier rule (checkable, zero tokens): refuse the run.
 *
 * Pure logic is exported and unit-tested; the file readers are thin wrappers.
 *
 * WEAKNESS, said out loud: "same failure" is decided by a normalized first failing log line plus
 * the exit code. Two genuinely different faults that print the same first line look identical and
 * trip the breaker early; one fault whose first line varies in words (not digits or paths) never
 * trips it. --max-per-hour is the backstop for that second case. --reset overrides the first.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Parser } from 'n3';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_MAX_PER_HOUR = 6;

export const stateDir = (): string => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons', 'jobs');
export const runsTtlPath = (): string => process.env.JOB_RUNS_TTL || path.join(mainCheckoutRoot(), 'reckons-workspace', 'kbs', 'jobs', 'job-runs.ttl');
export const currentPath = (): string => path.join(stateDir(), 'current.json');
export const circuitsPath = (): string => path.join(stateDir(), 'circuits.json');

export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';
/** The stable entity for a job name: one per --name, where its status lives. */
export const jobIri = (name: string): string => `urn:reckons:job/${slug(name)}`;

/** The graph the app opens for job-runs.ttl: a loose .ttl in a linked workspace is named after its file. */
export const JOBS_KB = 'job-runs';
export const DEFAULT_APP_URL = 'http://localhost:5173';

/**
 * Deep link into the app: the main graph page reads ?kb= (graph, by id or name) and ?sel= (the
 * selected node key). Pure. See src/routes/(app)/+layout.svelte and +page.svelte.
 */
export function jobLink(name: string, base: string = process.env.RECKONS_APP_URL || DEFAULT_APP_URL): string {
  return `${base.replace(/\/+$/, '')}/?kb=${encodeURIComponent(JOBS_KB)}&sel=${encodeURIComponent(jobIri(name))}`;
}

/** OSC 8 terminal hyperlink; a plain "text (url)" when the terminal cannot be assumed to render it. Pure. */
export function hyperlink(text: string, url: string, tty: boolean): string {
  return tty ? `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\` : `${text} (${url})`;
}

// ── failure signature ──────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const FAILURE_LINE = /\b(error|failed|failing|fatal|refus\w*|timed out|timeout|exception|cannot|could not)\b|\bFAIL\b|[✗✘×]/i;

/** Strip what varies between otherwise-identical failures: timestamps, paths, hashes, numbers. */
export function normalizeLine(s: string): string {
  return s
    .replace(ANSI, '')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<ts>')
    .replace(/\d{1,2}:\d{2}:\d{2}(\.\d+)?/g, '<ts>')
    .replace(/(?:[A-Za-z]:)?(?:\.{0,2}\/)[^\s:'"()]+/g, '<path>')
    .replace(/\b[0-9a-f]{7,40}\b/g, '<hash>')
    .replace(/\d+(\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 120);
}

/** exit code + first failing line, normalized. A pass has no signature. */
export function failureSignature(log: string, exitCode: number): string | undefined {
  if (exitCode === 0) return undefined;
  const first = log.replace(ANSI, '').split('\n').map((l) => l.trim()).find((l) => l && FAILURE_LINE.test(l));
  return `exit=${exitCode}|${first ? normalizeLine(first) : '(no failing line)'}`;
}

// ── breaker ────────────────────────────────────────────────────────────────

export type HistRun = { logPath?: string; name?: string; status: string; exitCode: number; signature?: string; startedAt: Date; endedAt?: Date; headline?: string };
export type BreakerOpts = { maxAttempts: number; maxPerHour: number; now: Date };
export type Decision = { allow: boolean; attempt: number; kind?: 'circuit' | 'hourly'; reason?: string; signature?: string };

/** Runs that spent compute. 'refused' and 'reset' are markers, not runs. */
const isMarker = (r: HistRun) => r.status === 'refused' || r.status === 'reset';

/** Length of the trailing run of failures that share one signature (stops at a pass, another signature, or a reset). */
export function failureStreak(history: HistRun[]): { count: number; signature?: string } {
  const sorted = [...history].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  let count = 0;
  let signature: string | undefined;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const r = sorted[i];
    if (r.status === 'reset') break;
    if (isMarker(r)) continue;
    if (r.exitCode === 0 || !r.signature) break;
    if (signature === undefined) signature = r.signature;
    else if (r.signature !== signature) break;
    count++;
  }
  return { count, signature };
}

/** Decide whether the next run of one job may start. `history` is that job's prior runs only. Pure. */
export function breakerDecision(history: HistRun[], o: BreakerOpts): Decision {
  const streak = failureStreak(history);
  const attempt = streak.count + 1;
  if (streak.count >= o.maxAttempts) {
    return { allow: false, attempt, kind: 'circuit', signature: streak.signature, reason: `circuit open: the last ${streak.count} runs all failed the same way (${streak.signature}); fix the cause or pass --reset` };
  }
  const since = o.now.getTime() - 3_600_000;
  const lastReset = Math.max(0, ...history.filter((r) => r.status === 'reset').map((r) => r.startedAt.getTime()));
  const recent = history.filter((r) => !isMarker(r) && r.startedAt.getTime() >= since && r.startedAt.getTime() >= lastReset).length;
  if (recent >= o.maxPerHour) {
    return { allow: false, attempt, kind: 'hourly', reason: `hourly cap: ${recent} runs in the last hour (max ${o.maxPerHour}), whatever their outcome; wait or pass --reset` };
  }
  return { allow: true, attempt };
}

/** Per-job open circuits, for the status views. */
export function openCircuits(all: HistRun[], maxAttempts: number): { name: string; count: number; signature: string }[] {
  const names = [...new Set(all.map((r) => r.name).filter((n): n is string => !!n))];
  const out: { name: string; count: number; signature: string }[] = [];
  for (const name of names) {
    const s = failureStreak(all.filter((r) => r.name === name));
    if (s.count >= maxAttempts && s.signature) out.push({ name, count: s.count, signature: s.signature });
  }
  return out;
}

// ── current.json ───────────────────────────────────────────────────────────

export type CurrentJob = { name: string; pid: number; started: string; attempt: number; maxAttempts: number };

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The entries that are really running: a stale entry whose pid is dead is not. Pure given `alive`. */
export function liveJobs(entries: CurrentJob[], alive: (pid: number) => boolean = pidAlive): CurrentJob[] {
  return entries.filter((e) => Number.isInteger(e.pid) && e.pid > 0 && alive(e.pid));
}

/** Merge a change into the entry list: replace the same pid, drop dead ones. Pure given `alive`. */
export function mergeCurrent(entries: CurrentJob[], change: { add?: CurrentJob; removePid?: number }, alive: (pid: number) => boolean = pidAlive): CurrentJob[] {
  let next = liveJobs(entries, alive).filter((e) => e.pid !== change.removePid && e.pid !== change.add?.pid);
  if (change.add) next = [...next, change.add];
  return next;
}

function readJson<T>(p: string, fallback: T): T {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : fallback; } catch { return fallback; }
}
function writeJson(p: string, v: unknown): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(v));
  renameSync(tmp, p);
}

export const readCurrent = (): CurrentJob[] => liveJobs(readJson<CurrentJob[]>(currentPath(), []));
export const updateCurrent = (change: { add?: CurrentJob; removePid?: number }): void =>
  writeJson(currentPath(), mergeCurrent(readJson<CurrentJob[]>(currentPath(), []), change));

/** Open circuits are cached for the status line, which must not parse TTL. */
export type CircuitCache = Record<string, { count: number; signature: string }>;
export const readCircuitCache = (): CircuitCache => readJson<CircuitCache>(circuitsPath(), {});
export function setCircuitCache(name: string, open: { count: number; signature: string } | null): void {
  const c = readCircuitCache();
  if (open) c[name] = open; else delete c[name];
  writeJson(circuitsPath(), c);
}

// ── history from job-runs.ttl ──────────────────────────────────────────────

const P = 'urn:kbase:predicate/';

export function parseRuns(ttl: string): HistRun[] {
  const by = new Map<string, Record<string, string>>();
  try {
    for (const q of new Parser().parse(ttl)) {
      if (!q.predicate.value.startsWith(P)) continue;
      const o = by.get(q.subject.value) ?? {};
      o[q.predicate.value.slice(P.length)] = q.object.value;
      by.set(q.subject.value, o);
    }
  } catch { return []; }
  const runs: HistRun[] = [];
  for (const o of by.values()) {
    if (!o['job-name'] || !o.started) continue;
    runs.push({ name: o['job-name'], status: o['has-status'] ?? '', exitCode: Number(o['exit-code'] ?? 1), signature: o['failure-signature'], logPath: o['log-path'], startedAt: new Date(o.started), endedAt: o.ended ? new Date(o.ended) : undefined, headline: o.headline });
  }
  return runs.sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
}

export function readRuns(ttlPath = runsTtlPath()): HistRun[] {
  try { return existsSync(ttlPath) ? parseRuns(readFileSync(ttlPath, 'utf8')) : []; } catch { return []; }
}
