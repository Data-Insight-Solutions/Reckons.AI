/**
 * SESSION QUEUE — the shared local-job queue (F74.7, F166.1.2).
 *
 * Matt, 2026-09-30, gated it on an active Claude Code session ("I don't want overnight").
 * Matt, 2026-10-23, removed that gate: "Lets remove queue run blocker that I need an active claude
 * session." Reckons itself now submits jobs (Shelly, generation), and a job the app asked for must
 * not wait for an unrelated CLI. The worker starts jobs whenever it is running; stopping it, or the
 * PAUSE file, is how the machine stays idle.
 *
 * Two pieces share this file: the QUEUE (plain JSONL, one job per line) and the WORKER STATE the
 * agent:watch window shows. Everything decidable is pure and unit-tested; the readers are thin.
 *
 * JOB CHAINS (Matt 2026-11-03: "craft local job chains"): a job may name predecessors with
 * `after: string[]` (`queue.ts add --after=<name>`, repeatable). It starts only when every
 * predecessor has at least one PASSED run in the done log; while a predecessor is currently queued it
 * waits (re-queueing a predecessor IS the user re-running it, so an older failed/blocked run in the
 * done log does not block); a predecessor whose last finished run did not pass (failed, refused,
 * dropped, no-commit) and that is not queued blocks the waiting job — the worker records it once as
 * 'blocked' with the reason and never runs it, because re-running the predecessor is the user's call. A cycle (each waiting on the other) is
 * reported as paused-broken-chain, not spun on.
 *
 * 'passed' must mean the work happened (requirement 3): the worker records the head of a deputy
 * job's worktree before and after the run; a clean exit that left it unchanged is 'no-commit',
 * and a no-commit run satisfies no chain link.
 */
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, appendFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withFileLock } from './state-file.js';
import { pidAlive } from './job-state.js';

const reckonsDir = (): string => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons');
export const queueDir = (): string => path.join(reckonsDir(), 'jobs');
export const queuePath = (): string => path.join(queueDir(), 'queue.jsonl');
export const donePath = (): string => path.join(queueDir(), 'queue.done.jsonl');
export const workerPath = (): string => path.join(queueDir(), 'worker.json');
export const pausePath = (): string => path.join(queueDir(), 'PAUSE');
export const queueLockPath = (): string => path.join(queueDir(), 'queue.lock');

// ── queue ──────────────────────────────────────────────────────────────────

export type QueueJob = { id: string; name: string; cwd: string; argv: string[]; addedAt: string; priority?: number;
  /** false = script tier, never touches the GPU, so the GPU gates do not apply. Absent = GPU (fail safe). */
  gpu?: boolean;
  /**
   * Which physical GPU to run on (0-based). The GPU gate judges that GPU only, and the worker pins
   * CUDA_VISIBLE_DEVICES / GGML_VK_VISIBLE_DEVICES to it at spawn (gen-bench.ts's pin pattern).
   * Absent = any GPU, judged on all of them (fail safe). E.g. a scan on GPU1 while the deputy's own
   * Ollama runtime legitimately heats GPU0 (Matt, 2026-11-10).
   */
  gpuIndex?: number;
  /** false = neither the job nor its job-watch verdict uses Ollama (generation), so it runs while Ollama
   *  is down. Absent = needs Ollama (fail safe). */
  ollama?: boolean;
  /** Job chains: the names (or ids) this job runs after; it starts only when each of them has a passed run. */
  after?: string[];
  /** true = this job's model may spill into system RAM (too big for VRAM); the RAM guard's spill check skips it, its floor does not (session-ram.ts). */
  ramSpill?: boolean };
export type DoneJob = QueueJob & { finishedAt: string; outcome: 'passed' | 'failed' | 'refused' | 'dropped' | 'blocked' | 'no-commit'; exitCode?: number;
  /** In words: which link blocked a job, or what 'no-commit' checked and found. */
  reason?: string;
  /** Deputy jobs in a git worktree: the head before and after the run; equal = no-commit. */
  headBefore?: string; headAfter?: string };

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
        const after = Array.isArray(j.after) ? j.after.filter((a) => typeof a === 'string' && a.length > 0) : undefined;
        out.push({ id: j.id, name: j.name, cwd: j.cwd, argv: j.argv, addedAt: j.addedAt, ...(typeof j.priority === 'number' ? { priority: j.priority } : {}), ...(j.gpu === false ? { gpu: false } : {}), ...(typeof j.gpuIndex === 'number' ? { gpuIndex: j.gpuIndex } : {}), ...(after?.length ? { after } : {}), ...(j.ramSpill === true ? { ramSpill: true } : {}), ...(j.ollama === false ? { ollama: false } : {}) });
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

export const newJob = (name: string, cwd: string, argv: string[], priority?: number, gpu?: boolean, after?: string[], ramSpill?: boolean, ollama?: boolean, gpuIndex?: number): QueueJob =>
  ({ id: randomUUID().slice(0, 8), name, cwd, argv, addedAt: new Date().toISOString(), ...(priority !== undefined ? { priority } : {}), ...(gpu === false ? { gpu: false } : {}), ...(typeof gpuIndex === 'number' ? { gpuIndex } : {}), ...(after?.length ? { after: [...after] } : {}), ...(ramSpill ? { ramSpill: true } : {}), ...(ollama === false ? { ollama: false } : {}) });

export const isGpuJob = (j: Pick<QueueJob, 'gpu'>): boolean => j.gpu !== false;
export const needsOllama = (j: Pick<QueueJob, 'ollama'>): boolean => j.ollama !== false;

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

export type WorkerState = 'ready' | 'working' | 'paused-ollama-down' | 'paused-manual' | 'paused-resources' | 'paused-broken-chain' | 'empty';

export type StepInput = {
  queue: QueueJob[];
  running: boolean;
  ollamaUp: boolean;
  /** The PAUSE file exists. */
  manualPause?: boolean;
  /** Why GPU jobs may not start (full, hot, busy, unknown); undefined = the GPU is fine. */
  gpuBlocked?: string;
  /** The done log: chain links are judged against it (a link is satisfied by a passed run). */
  done?: DoneJob[];
};
export type Step = { state: WorkerState; startJob: boolean; reason?: string };

export type ChainStatus =
  | { status: 'ready' }
  | { status: 'waiting'; on: string[] }
  | { status: 'blocked'; reasons: string[] };

/**
 * Job chains, per link (Matt 2026-11-03). A link is satisfied by ONE passed run of a job whose
 * name OR id is the link (the queue shows names; ids are accepted so a copy from `list` works).
 * Order: a passed run -> satisfied; else the dep is currently queued -> WAITING (re-queueing a
 * predecessor IS the user re-running it, so an older unpassed run in the done log is stale); else its
 * last finished run did not pass (failed, refused, dropped, no-commit) -> BLOCKED — the predecessor
 * did not do its work, and re-running it is the user's act, not the worker's; a link to a job that is
 * nowhere is broken too. Blocked wins over waiting across links. Pure.
 */
export function afterChain(job: Pick<QueueJob, 'after'>, queue: QueueJob[], done: DoneJob[]): ChainStatus {
  const deps = job.after ?? [];
  if (deps.length === 0) return { status: 'ready' };
  const inQueue = new Map<string, string>(); // dep -> the queued job's name (the reason shows names)
  for (const j of queue) for (const dep of deps) if (j.name === dep || j.id === dep) inQueue.set(dep, j.name);
  const on: string[] = [];
  const reasons: string[] = [];
  for (const dep of deps) {
    const runs = done.filter((d) => d.name === dep || d.id === dep);
    if (runs.some((r) => r.outcome === 'passed')) continue; // the work happened once; a later failure does not un-happen it
    if (inQueue.has(dep)) { on.push(inQueue.get(dep)!); continue; } // a fresh run is queued: wait for it, whatever older runs did
    if (runs.length > 0) {
      const last = runs.slice().sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).at(-1)!;
      reasons.push(`after "${dep}" finished "${last.outcome}"${last.reason ? ` (${last.reason})` : ''}`);
      continue;
    }
    reasons.push(`after "${dep}" never ran (not in the queue, not in the done log)`);
  }
  if (reasons.length) return { status: 'blocked', reasons };
  if (on.length) return { status: 'waiting', on };
  return { status: 'ready' };
}

/** Queued jobs that must never run as things stand, each with its full reason (the worker records them once, 'blocked'). Pure. */
export function chainBlocked(queue: QueueJob[], done: DoneJob[]): { job: QueueJob; reason: string }[] {
  const out: { job: QueueJob; reason: string }[] = [];
  for (const j of queue) {
    const s = afterChain(j, queue, done);
    if (s.status === 'blocked') out.push({ job: j, reason: s.reasons.join('; ') });
  }
  return out;
}

/**
 * When nothing can start but the stall is a chain, the links point at each other (a cycle):
 * "a waiting on b; b waiting on a". undefined when nothing is waiting (the stall is something
 * else — e.g. the GPU gate — or the queue is all blocked jobs, which the worker records out). Pure.
 */
export function chainStallReason(queue: QueueJob[], done: DoneJob[]): string | undefined {
  const waiting: { name: string; on: string[] }[] = [];
  for (const j of queue) {
    const s = afterChain(j, queue, done);
    if (s.status === 'waiting') waiting.push({ name: j.name, on: s.on });
  }
  if (waiting.length === 0) return undefined;
  return waiting.map((w) => `${w.name} waiting on ${w.on.join(', ')}`).join('; ');
}

/** The next job to start: the first in order that both resource gates (GPU, Ollama) AND its chain allow. Pure. */
export function pickNext(ordered: QueueJob[], gpuBlocked?: string, done: DoneJob[] = [], queue: QueueJob[] = ordered, ollamaUp = true): QueueJob | undefined {
  return ordered.find((j) => (!isGpuJob(j) || !gpuBlocked) && (!needsOllama(j) || ollamaUp) && afterChain(j, queue, done).status === 'ready');
}

/**
 * What the worker does next. The invariants live here: a job STARTS only with no PAUSE file AND
 * something startable queued AND nothing already running; a GPU job additionally needs the GPU gate
 * open, and a job that uses Ollama needs Ollama up. A running job is never interrupted (it finishes,
 * then this is asked again), and `running` makes a second concurrent job impossible. Pure.
 */
export function workerStep(i: StepInput): Step {
  if (i.running) return { state: 'working', startJob: false };
  if (i.queue.length === 0) return { state: 'empty', startJob: false };
  if (i.manualPause) return { state: 'paused-manual', startJob: false };
  if (pickNext(orderQueue(i.queue), i.gpuBlocked, i.done ?? [], i.queue, i.ollamaUp)) return { state: 'working', startJob: true };
  if (!i.ollamaUp && (!i.gpuBlocked || i.queue.some(needsOllama))) return { state: 'paused-ollama-down', startJob: false };
  const stall = chainStallReason(i.queue, i.done ?? []);
  if (stall) return { state: 'paused-broken-chain', startJob: false, reason: stall };
  return { state: 'paused-resources', startJob: false, reason: i.gpuBlocked };
}

export type WorkerFile = { state: WorkerState; reason?: string; pid?: number; at?: string; job?: string; attempt?: number; maxAttempts?: number; index?: number; total?: number;
  /** Schedules the worker is holding back, each with its reason (heldSchedules, backlogHolds). */
  held?: string[] };

/**
 * A recorded worker pid is a running worker only while it is alive AND, where /proc can say, still
 * runs queue-worker. Observed 2026-10-09: a worker died without clearing worker.json, Linux reused
 * its pid for VS Code's ESLint server, and every new worker refused to start behind a lock that no
 * worker held. Without /proc (macOS) this falls back to liveness alone.
 */
export function workerPidAlive(pid: number, readCmdline: (pid: number) => string = (p) => readFileSync(`/proc/${p}/cmdline`, 'utf8'), alive: (pid: number) => boolean = pidAlive, hasProc: () => boolean = () => existsSync('/proc/self')): boolean {
  if (!alive(pid)) return false;
  try { return readCmdline(pid).includes('queue-worker'); }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT' || !hasProc(); }
}

export function readWorker(alive: (pid: number) => boolean = workerPidAlive): WorkerFile | undefined {
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

export type QueueView = ({ kind: 'ready'; queued: number }
  | { kind: 'working'; job: string; attempt?: number; maxAttempts?: number; index: number; total: number; queued: number }
  | { kind: 'paused-ollama-down'; queued: number }
  | { kind: 'paused-manual'; queued: number }
  | { kind: 'paused-resources'; queued: number; reason?: string }
  | { kind: 'paused-broken-chain'; queued: number; reason?: string }
  | { kind: 'empty' }) & { held?: string[] };

export type ViewInput = { queued: number; worker?: WorkerFile; ollamaUp: boolean; manualPause?: boolean;
  /** How many queued jobs use Ollama. Absent = all of them (fail safe). */
  needOllama?: number };

/**
 * One classification for the window and the status line. A live worker reports its own state;
 * with no worker running, "ready" means someone COULD start one (jobs queued that the Ollama gate
 * allows, not paused) — it is a suggestion, not a promise. Pure.
 */
export function queueView(i: ViewInput): QueueView {
  return { ...classify(i), ...(i.worker?.held?.length ? { held: i.worker.held } : {}) };
}

function classify(i: ViewInput): QueueView {
  const w = i.worker;
  if (w?.state === 'working' && w.job) {
    return { kind: 'working', job: w.job, attempt: w.attempt, maxAttempts: w.maxAttempts, index: w.index ?? 1, total: w.total ?? i.queued + 1, queued: i.queued };
  }
  if (i.queued === 0) return { kind: 'empty' };
  if (i.manualPause) return { kind: 'paused-manual', queued: i.queued };
  if (!i.ollamaUp && (i.needOllama ?? i.queued) === i.queued) return { kind: 'paused-ollama-down', queued: i.queued };
  if (w?.state === 'paused-resources') return { kind: 'paused-resources', queued: i.queued, reason: w.reason };
  if (w?.state === 'paused-broken-chain') return { kind: 'paused-broken-chain', queued: i.queued, reason: w.reason };
  return { kind: 'ready', queued: i.queued };
}

/** Reads the cheap inputs (a stat, a small file, a pid probe) and classifies. */
export function readQueueView(ollamaUp: boolean): QueueView {
  const queue = readQueue();
  return queueView({ queued: queue.length, needOllama: queue.filter(needsOllama).length, worker: readWorker(), ollamaUp, manualPause: isPaused() });
}

export const START_COMMAND = 'npm run agent:queue-worker';

/** One short segment for the status bar. Pure. */
export function queueSegment(v: QueueView): string {
  switch (v.kind) {
    case 'ready': return `ready ${v.queued}`;
    case 'working': return `working ${v.index}/${v.total}`;
    case 'paused-ollama-down': case 'paused-manual': case 'paused-resources': case 'paused-broken-chain': return 'paused';
    case 'empty': return 'empty';
  }
}
