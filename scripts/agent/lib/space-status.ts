/**
 * F74.14 — the pure model behind the per-workspace status file: the workers alive, and for each
 * run made for this workspace its job, its state, its reason, and its result.
 *
 * F74.14 in the roadmap (the job-to-workspace channel phase) fixes the design: the status is a
 * small file rebuilt from the worker's own records, so deleting it loses nothing; it shows only
 * runs whose target is in its own workspace, so a run made for a private folder never appears in
 * another folder's file. This module is that rebuild as a pure function — it receives
 * already-parsed records (the queue, the done log, the running list, the worker's heartbeat) and
 * reads no files. Nothing here is wired into the app or the worker yet; the writer and the
 * readers (the app's poll, agent:watch) sit on top of this in a later branch.
 *
 * STATE IS SHOWN, NEVER PROPOSED (the F74.14 principle): the rows this returns are state a person
 * can see — running, held with the reason, done, failed — not facts they are asked to accept.
 *
 * FIRST DRAFT, for an overseer to review. The calls it leaves to that review: which finished
 * outcomes read as 'done' and which as 'failed' (here: 'passed' is done, everything the done log
 * records otherwise is failed, carrying its reason), and the target's priority order (the one its
 * result names first, then the one declared on the record).
 */
import type { CurrentJob } from '../job-state.js';
import type { DoneJob, QueueJob, WorkerFile } from '../session-queue.js';

/** A heartbeat older than this counts the worker as not alive. */
export const HEARTBEAT_STALE_MS = 2 * 60 * 1000;
/** Finished runs kept in the view; older ones stay in the done log and are only dropped here. */
export const FINISHED_KEPT = 20;

/** The five states a job can be in this view (F74.14: queued, running, held with reason, done, failed). */
export type JobStatusState = 'queued' | 'running' | 'held' | 'done' | 'failed';

export type JobStatusEntry = {
  name: string;
  state: JobStatusState;
  /** Why it is held back, or what a finished run reported. */
  reason?: string;
  /** When this state began (running, held, queued) or ended (done, failed), ISO. */
  since?: string;
  /** What a finished run says it produced, when it wrote one. */
  result?: Record<string, unknown>;
};

/** What the status file holds for one workspace: who is alive, and the jobs that concern it. */
export type SpaceStatus = { workersAlive: number; jobs: JobStatusEntry[] };

export type SpaceStatusInput = {
  /** The worker's own record; its `at` field is its last heartbeat. Absent = no worker. */
  worker: WorkerFile | undefined;
  /** What is running now (current.json). */
  current: CurrentJob[];
  /** What is queued (queue.jsonl). */
  queued: QueueJob[];
  /** The finished runs (queue.done.jsonl). */
  done: DoneJob[];
  /** Why the worker is holding each job back, name to reason (heldSchedules, backlogHolds). */
  held: ReadonlyMap<string, string>;
  /** The targets this view is for: a job made for a target outside this list does not appear. */
  spacesInWorkspace: string[];
  /** Whether to show jobs that name no target at all. Absent = they do not appear. */
  includeUntargeted?: boolean;
  now: Date;
};

/** The target declared on a record, when the record carries one (the declared-target field). */
const declaredTarget = (record: QueueJob): string | undefined => {
  const v = (record as QueueJob & { space?: unknown }).space;
  return typeof v === 'string' && v.length > 0 ? v : undefined;
};

/** A run's target: the one its result names first, then the one declared on the record, if any. */
const targetOf = (record: QueueJob & { result?: Record<string, unknown> }): string | undefined => {
  const named = record.result?.space;
  if (typeof named === 'string' && named.length > 0) return named;
  return declaredTarget(record);
};

type Slot = {
  queued?: QueueJob;
  finished?: DoneJob;
  running?: CurrentJob;
  held?: string;
};

/** The newest of two records sharing a name (later timestamp wins; on a tie the later one). */
const newerOf = (a: { addedAt: string } | undefined, b: { addedAt: string }): { addedAt: string } =>
  a === undefined || b.addedAt.localeCompare(a.addedAt) >= 0 ? b : a;

const newerFinished = (a: DoneJob | undefined, b: DoneJob): DoneJob =>
  a === undefined || (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '') >= 0 ? b : a;

/**
 * Rebuild the status view for one workspace from the worker's own records. Pure: the same records
 * and the same `now` give the same rows. A job appears only when its target is in
 * `spacesInWorkspace`, or when it names no target and `includeUntargeted` is true; at most the
 * `FINISHED_KEPT` newest finished jobs appear. State priority for one name: running, then held,
 * then queued, then the newest finished record.
 */
export function buildSpaceStatus(i: SpaceStatusInput): SpaceStatus {
  const targets = new Set(i.spacesInWorkspace.filter((t) => typeof t === 'string' && t.length > 0));
  const includeUntargeted = i.includeUntargeted === true;
  const inScope = (target: string | undefined): boolean =>
    target === undefined ? includeUntargeted : targets.has(target);

  const slots = new Map<string, Slot>();
  const slot = (name: string): Slot => {
    let s = slots.get(name);
    if (!s) { s = {}; slots.set(name, s); }
    return s;
  };

  for (const q of i.queued) slot(q.name).queued = newerOf(slot(q.name).queued, q);
  for (const d of i.done) slot(d.name).finished = newerFinished(slot(d.name).finished, d);
  for (const c of i.current) if (slot(c.name).running === undefined) slot(c.name).running = c;
  for (const [name, reason] of i.held) slot(name).held = reason;

  const entryFor = (name: string, s: Slot): JobStatusEntry | undefined => {
    const target = (s.finished ? targetOf(s.finished) : undefined) ?? (s.queued ? targetOf(s.queued) : undefined);
    if (!inScope(target)) return undefined;
    if (s.running) {
      const e: JobStatusEntry = { name, state: 'running' };
      const since = s.running.started ?? s.queued?.addedAt;
      if (since) e.since = since;
      return e;
    }
    if (s.held !== undefined) {
      const e: JobStatusEntry = { name, state: 'held', reason: s.held };
      const since = s.queued?.addedAt ?? s.finished?.finishedAt;
      if (since) e.since = since;
      return e;
    }
    if (s.queued) return { name, state: 'queued', since: s.queued.addedAt };
    const f = s.finished;
    if (f) {
      const e: JobStatusEntry = { name, state: f.outcome === 'passed' ? 'done' : 'failed' };
      if (f.reason) e.reason = f.reason;
      if (f.finishedAt) e.since = f.finishedAt;
      if (f.result) e.result = f.result;
      return e;
    }
    return undefined;
  };

  const entries = [...slots.entries()]
    .map(([name, s]) => entryFor(name, s))
    .filter((e): e is JobStatusEntry => e !== undefined);

  // Keep only the FINISHED_KEPT newest finished jobs; the others stay in the done log.
  const keepFinished = new Set(
    entries
      .filter((e) => e.state === 'done' || e.state === 'failed')
      .sort((a, b) => (b.since ?? '').localeCompare(a.since ?? '') || a.name.localeCompare(b.name))
      .slice(0, FINISHED_KEPT),
  );
  const jobs = entries.filter((e) => keepFinished.has(e) || (e.state !== 'done' && e.state !== 'failed'));

  // A stable order to show: running first, then held, queued, done, failed; by name within each.
  const rank: Record<JobStatusState, number> = { running: 0, held: 1, queued: 2, done: 3, failed: 4 };
  jobs.sort((a, b) => rank[a.state] - rank[b.state] || a.name.localeCompare(b.name));

  // A worker is alive while its last heartbeat is within HEARTBEAT_STALE_MS of now.
  let workersAlive = 0;
  const at = Date.parse(i.worker?.at ?? '');
  if (Number.isFinite(at) && i.now.getTime() - at <= HEARTBEAT_STALE_MS) workersAlive = 1;

  return { workersAlive, jobs };
}
