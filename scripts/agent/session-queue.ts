/**
 * SESSION QUEUE — local jobs that run only while a Claude Code session is active (F74.7).
 *
 * Matt, 2026-09-30: "I don't want overnight, I want whenever there is an active session for
 * escalations. I want my agent watch usage to indicate 'ready' to utilize local task processing and
 * work through the queue. I don't want to leave on my machine all night for a burst of activity
 * while I sleep."
 *
 * Three small pieces share this file: the HEARTBEAT (mtime of a file a Claude Code hook touches),
 * the QUEUE (plain JSONL, one job per line) and the WORKER STATE the agent:watch window shows.
 * Everything decidable is pure and unit-tested; the readers are thin.
 *
 * WEAKNESS, said out loud: "active session" is inferred from a hook firing recently, so a session
 * left open but unattended counts as active until --idle-minutes passes, and a hook that was never
 * installed reads as "no session" forever. The heartbeat proves a prompt was submitted, not that a
 * human is watching.
 */
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, appendFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './state-file.js';
import { pidAlive } from './job-state.js';

export const DEFAULT_IDLE_MINUTES = 20;

const reckonsDir = (): string => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons');
export const heartbeatPath = (): string => path.join(reckonsDir(), 'session-heartbeat');
export const queueDir = (): string => path.join(reckonsDir(), 'jobs');
export const queuePath = (): string => path.join(queueDir(), 'queue.jsonl');
export const donePath = (): string => path.join(queueDir(), 'queue.done.jsonl');
export const workerPath = (): string => path.join(queueDir(), 'worker.json');
export const pausePath = (): string => path.join(queueDir(), 'PAUSE');
export const queueLockPath = (): string => path.join(queueDir(), 'queue.lock');

// ── heartbeat ──────────────────────────────────────────────────────────────

/** Fresh = touched within `idleMinutes`. A missing heartbeat (mtime undefined) is never fresh. Pure. */
export function heartbeatFresh(mtimeMs: number | undefined, nowMs: number, idleMinutes = DEFAULT_IDLE_MINUTES): boolean {
  if (mtimeMs === undefined || !Number.isFinite(mtimeMs)) return false;
  return nowMs - mtimeMs <= idleMinutes * 60_000; // a heartbeat slightly in the future (clock skew) is fresh
}

export function readHeartbeatMtime(): number | undefined {
  try { return statSync(heartbeatPath()).mtimeMs; } catch { return undefined; }
}

// ── queue ──────────────────────────────────────────────────────────────────

export type QueueJob = { id: string; name: string; cwd: string; argv: string[]; addedAt: string; priority?: number;
  /** false = script tier, never touches the GPU, so the GPU gates do not apply. Absent = GPU (fail safe). */
  gpu?: boolean };
export type DoneJob = QueueJob & { finishedAt: string; outcome: 'passed' | 'failed' | 'refused' | 'dropped'; exitCode?: number };

/** Dedupe key: the same named job in the same directory. */
export const jobKey = (j: Pick<QueueJob, 'name' | 'cwd'>): string => `${j.name}\u0000${j.cwd}`;

/** Parse JSONL leniently: a malformed or invalid line is skipped, never fatal. Pure. */
export function parseQueue(text: string): QueueJob[] {
  const out: QueueJob[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as Partial<QueueJob>;
      if (typeof j.id === 'string' && typeof j.name === 'string' && typeof j.cwd === 'string' && typeof j.addedAt === 'string'
        && Array.isArray(j.argv) && j.argv.length > 0 && j.argv.every((a) => typeof a === 'string')) {
        out.push({ id: j.id, name: j.name, cwd: j.cwd, argv: j.argv, addedAt: j.addedAt, ...(typeof j.priority === 'number' ? { priority: j.priority } : {}), ...(j.gpu === false ? { gpu: false } : {}) });
      }
    } catch { /* skip */ }
  }
  return out;
}

export const serializeQueue = (jobs: QueueJob[]): string => jobs.map((j) => JSON.stringify(j)).join('\n') + (jobs.length ? '\n' : '');

/** Highest priority first, then oldest first. Stable. Pure. */
export function orderQueue(jobs: QueueJob[]): QueueJob[] {
  return jobs.map((j, i) => ({ j, i })).sort((a, b) => (b.j.priority ?? 0) - (a.j.priority ?? 0) || a.j.addedAt.localeCompare(b.j.addedAt) || a.i - b.i).map((x) => x.j);
}

/** Split candidates into those to add and those skipped as already queued (also dedupes within the batch). Pure. */
export function dedupeAdd(existing: QueueJob[], candidates: QueueJob[]): { add: QueueJob[]; skipped: QueueJob[] } {
  const seen = new Set(existing.map(jobKey));
  const add: QueueJob[] = [];
  const skipped: QueueJob[] = [];
  for (const c of candidates) {
    if (seen.has(jobKey(c))) skipped.push(c);
    else { seen.add(jobKey(c)); add.push(c); }
  }
  return { add, skipped };
}

export const newJob = (name: string, cwd: string, argv: string[], priority?: number, gpu?: boolean): QueueJob =>
  ({ id: randomUUID().slice(0, 8), name, cwd, argv, addedAt: new Date().toISOString(), ...(priority !== undefined ? { priority } : {}), ...(gpu === false ? { gpu: false } : {}) });

export const isGpuJob = (j: Pick<QueueJob, 'gpu'>): boolean => j.gpu !== false;

export const isPaused = (): boolean => existsSync(pausePath());

export function setPaused(on: boolean): void {
  mkdirSync(queueDir(), { recursive: true });
  if (on) writeFileSync(pausePath(), `paused ${new Date().toISOString()}\n`);
  else rmSync(pausePath(), { force: true });
}

export function readQueue(): QueueJob[] {
  try { return existsSync(queuePath()) ? parseQueue(readFileSync(queuePath(), 'utf8')) : []; } catch { return []; }
}

export function readDone(): DoneJob[] {
  try {
    return existsSync(donePath())
      ? readFileSync(donePath(), 'utf8').split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as DoneJob] : []; } catch { return []; } })
      : [];
  } catch { return []; }
}

/** Single writer: every mutation takes the queue lock, re-reads, applies, and atomically rewrites. */
export function mutateQueue<T>(fn: (jobs: QueueJob[]) => { jobs: QueueJob[]; done?: DoneJob[]; result: T }): T {
  return withFileLock(queueLockPath(), () => {
    const r = fn(readQueue());
    mkdirSync(queueDir(), { recursive: true });
    const tmp = `${queuePath()}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeQueue(r.jobs));
    renameSync(tmp, queuePath());
    if (r.done?.length) appendFileSync(donePath(), r.done.map((d) => JSON.stringify(d)).join('\n') + '\n');
    return r.result;
  });
}

/** Append candidates not already queued. Returns what was added and what was skipped. */
export function addJobs(candidates: QueueJob[], alsoSkip: (j: QueueJob) => boolean = () => false): { add: QueueJob[]; skipped: QueueJob[] } {
  return mutateQueue((jobs) => {
    const r = dedupeAdd(jobs, candidates.filter((c) => !alsoSkip(c)));
    return { jobs: [...jobs, ...r.add], result: { add: r.add, skipped: [...r.skipped, ...candidates.filter(alsoSkip)] } };
  });
}

// ── worker state machine ───────────────────────────────────────────────────

export type WorkerState = 'ready' | 'working' | 'paused-idle' | 'paused-ollama-down' | 'paused-manual' | 'paused-resources' | 'empty';

export type StepInput = {
  queue: QueueJob[];
  running: boolean;
  heartbeatFresh: boolean;
  ollamaUp: boolean;
  /** The PAUSE file exists. */
  manualPause?: boolean;
  /** Why GPU jobs may not start (full, hot, busy, unknown); undefined = the GPU is fine. */
  gpuBlocked?: string;
};
export type Step = { state: WorkerState; startJob: boolean; reason?: string };

/** The next job to start: the first in order that the resource gate allows (script jobs pass a blocked GPU). Pure. */
export function pickNext(ordered: QueueJob[], gpuBlocked?: string): QueueJob | undefined {
  return ordered.find((j) => !isGpuJob(j) || !gpuBlocked);
}

/**
 * What the worker does next. The invariants live here: a job STARTS only with a fresh heartbeat AND
 * Ollama up AND no PAUSE file AND something startable queued AND nothing already running; a GPU job
 * additionally needs the GPU gate open. A running job is never interrupted (it finishes, then this
 * is asked again), and `running` makes a second concurrent job impossible. Pure.
 */
export function workerStep(i: StepInput): Step {
  if (i.running) return { state: 'working', startJob: false };
  if (i.queue.length === 0) return { state: 'empty', startJob: false };
  if (i.manualPause) return { state: 'paused-manual', startJob: false };
  if (!i.heartbeatFresh) return { state: 'paused-idle', startJob: false };
  if (!i.ollamaUp) return { state: 'paused-ollama-down', startJob: false };
  if (!pickNext(orderQueue(i.queue), i.gpuBlocked)) return { state: 'paused-resources', startJob: false, reason: i.gpuBlocked };
  return { state: 'working', startJob: true };
}

export type WorkerFile = { state: WorkerState; reason?: string; pid?: number; at?: string; job?: string; attempt?: number; maxAttempts?: number; index?: number; total?: number };

export function readWorker(alive: (pid: number) => boolean = pidAlive): WorkerFile | undefined {
  try {
    const w = JSON.parse(readFileSync(workerPath(), 'utf8')) as WorkerFile;
    return w.pid !== undefined && Number.isInteger(w.pid) && alive(w.pid) ? w : undefined;
  } catch { return undefined; }
}

export function writeWorker(w: WorkerFile): void {
  mkdirSync(queueDir(), { recursive: true });
  const tmp = `${workerPath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...w }));
  renameSync(tmp, workerPath());
}

// ── what agent:watch shows ─────────────────────────────────────────────────

export type QueueView =
  | { kind: 'ready'; queued: number }
  | { kind: 'working'; job: string; attempt?: number; maxAttempts?: number; index: number; total: number; queued: number }
  | { kind: 'paused-idle'; queued: number }
  | { kind: 'paused-ollama-down'; queued: number }
  | { kind: 'paused-manual'; queued: number }
  | { kind: 'paused-resources'; queued: number; reason?: string }
  | { kind: 'empty' };

export type ViewInput = { queued: number; worker?: WorkerFile; heartbeatFresh: boolean; ollamaUp: boolean; manualPause?: boolean };

/**
 * One classification for the window and the status line. A live worker reports its own state;
 * with no worker running, "ready" means someone COULD start one (session active, Ollama up, jobs
 * queued, not paused) — it is a suggestion, not a promise. Pure.
 */
export function queueView(i: ViewInput): QueueView {
  const w = i.worker;
  if (w?.state === 'working' && w.job) {
    return { kind: 'working', job: w.job, attempt: w.attempt, maxAttempts: w.maxAttempts, index: w.index ?? 1, total: w.total ?? i.queued + 1, queued: i.queued };
  }
  if (i.queued === 0) return { kind: 'empty' };
  if (i.manualPause) return { kind: 'paused-manual', queued: i.queued };
  if (!i.heartbeatFresh) return { kind: 'paused-idle', queued: i.queued };
  if (!i.ollamaUp) return { kind: 'paused-ollama-down', queued: i.queued };
  if (w?.state === 'paused-resources') return { kind: 'paused-resources', queued: i.queued, reason: w.reason };
  return { kind: 'ready', queued: i.queued };
}

/** Reads the cheap inputs (a stat, a stat, a small file, a pid probe) and classifies. */
export function readQueueView(ollamaUp: boolean, now = Date.now(), idleMinutes = DEFAULT_IDLE_MINUTES): QueueView {
  return queueView({ queued: readQueue().length, worker: readWorker(), heartbeatFresh: heartbeatFresh(readHeartbeatMtime(), now, idleMinutes), ollamaUp, manualPause: isPaused() });
}

export const START_COMMAND = 'npm run agent:queue-worker';

/** One short segment for the status bar. Pure. */
export function queueSegment(v: QueueView): string {
  switch (v.kind) {
    case 'ready': return `ready ${v.queued}`;
    case 'working': return `working ${v.index}/${v.total}`;
    case 'paused-idle': case 'paused-ollama-down': case 'paused-manual': case 'paused-resources': return 'paused';
    case 'empty': return 'empty';
  }
}
