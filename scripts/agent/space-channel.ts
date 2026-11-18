/**
 * F74.14 — the host side of the one channel between a local job and a workspace folder.
 *
 * Layout inside the workspace folder, ONE WRITER PER FILE:
 *   job-channel/requests/<id>.json         written by the app (or any writer), once; never touched here
 *   job-channel/requests/<id>.status.json  written by this worker: refused (with the reason), queued,
 *                                          running, done or failed
 *   job-channel/status.json                written by this worker, whole, only when it changed: the
 *                                          workers alive and the jobs whose target is in THIS workspace
 * Deleting either status file loses nothing; both are rebuilt from the queue's own records.
 *
 * A synced folder is not a remote shell. A request names a defined job kind (CHANNEL_JOBS) with typed
 * parameters; validateJobRequest decides, toArgv builds the argument list from the defined job's
 * command, and that list goes into the existing local queue (scripts/agent/session-queue.ts, so the
 * GPU and RAM gates, the circuit breaker and agent:watch cover it). No HTTP listener, no shell, and no
 * request text is ever part of a command string. It runs beside GenerationRunner (same
 * queue-worker tick, same atomic-write and symlink rules); generation requests keep their own path.
 *
 * NOT built here (F303): claims and leases, matching a request to a device's capabilities, signatures.
 * Held reasons come only from broken job chains, not from schedule or back-pressure holds.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { atomic, safeDirectory } from '../content/generation-runner.js';
import { CHANNEL_JOBS, toArgv, validateJobRequest, type ChannelJob } from './lib/job-request.js';
import { buildSpaceStatus, type SpaceStatus } from './lib/space-status.js';
import { addJobs, chainBlocked, newJob, readDone, readQueue, readWorker, type DoneJob, type QueueJob, type WorkerFile } from './session-queue.js';
import { readCurrent, type CurrentJob } from './job-state.js';

export const CHANNEL_DIR = 'job-channel';
const MAX_REQUEST_BYTES = 8_000;
const repoRoot = resolve(dirname(import.meta.filename), '..', '..');

/** The queue name for one request: unique per request, and free of any request text but the id. */
export const channelJobName = (job: string, id: string): string => `chan-${job}-${id}`;

/** The spaces a workspace folder holds: the entries of its kbs folder, by name without .ttl. */
export function spacesIn(workspace: string): string[] {
  const kbs = join(workspace, 'kbs');
  if (!existsSync(kbs)) return [];
  return readdirSync(kbs).map((f) => f.replace(/\.ttl$/, '')).filter((f) => /^[A-Za-z0-9_-]{1,64}$/.test(f));
}

/** Read one request file as unchecked JSON. undefined for anything that is not a plain small file
 *  named <id>.json whose content parses (the writer may still be mid-write). */
function readRequestFile(dir: string, file: string): unknown {
  const p = join(dir, file);
  const st = lstatSync(p);
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_REQUEST_BYTES) return undefined;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return undefined; }
}

export type ChannelRecords = {
  worker: WorkerFile | undefined;
  current: CurrentJob[];
  queued: QueueJob[];
  done: DoneJob[];
};

export const readRecords = (): ChannelRecords => ({ worker: readWorker(), current: readCurrent(), queued: readQueue(), done: readDone() });

export type ChannelOptions = {
  jobs?: Readonly<Record<string, ChannelJob>>;
  records?: () => ChannelRecords;
  now?: () => Date;
};

export class JobChannel {
  readonly root: string;
  readonly requests: string;
  private last = '';
  constructor(readonly workspace: string, private readonly opts: ChannelOptions = {}) {
    this.root = join(realpathSync(workspace), CHANNEL_DIR);
    safeDirectory(this.root);
    this.requests = join(this.root, 'requests');
    safeDirectory(this.requests);
  }

  /** One pass: answer new requests, follow queued ones, rewrite the status file if it changed.
   *  Returns true when it added a job, so the worker can start it without waiting a poll. */
  tick(): boolean {
    const jobs = this.opts.jobs ?? CHANNEL_JOBS;
    const records = (this.opts.records ?? readRecords)();
    const now = (this.opts.now ?? (() => new Date()))();
    const spaces = spacesIn(realpathSync(this.workspace));
    let added = false;

    for (const file of readdirSync(this.requests).sort()) {
      if (!file.endsWith('.json') || file.endsWith('.status.json')) continue;
      const id = file.slice(0, -'.json'.length);
      // The id becomes part of a file name and a queue name, so a name that is not a plain id is skipped unread.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      const statusPath = join(this.requests, `${id}.status.json`);
      if (existsSync(statusPath)) { this.follow(id, statusPath, records); continue; }
      const raw = readRequestFile(this.requests, file);
      if (raw === undefined) continue;
      // The id comes from the file name AND the content, and they must agree: it names the status file.
      const verdict = validateJobRequest(raw as never, jobs, { spaces });
      if (!verdict.ok) { atomic(statusPath, { id, state: 'refused', reason: verdict.reason }); continue; }
      if (verdict.id !== id) { atomic(statusPath, { id, state: 'refused', reason: 'the id inside the request must match its file name' }); continue; }
      const spec = jobs[verdict.job]!;
      const name = channelJobName(verdict.job, verdict.id);
      const job: QueueJob = { ...newJob(name, repoRoot, toArgv(verdict, jobs), undefined, spec.gpu, undefined, undefined, spec.ollama), space: verdict.space };
      if (addJobs([job]).add.length) added = true;
      atomic(statusPath, { id, state: 'queued', queueName: name });
    }

    const held = new Map(chainBlocked(records.queued, records.done).map((b) => [b.job.name, b.reason] as const));
    const status: SpaceStatus = buildSpaceStatus({ ...records, held, spacesInWorkspace: spaces, now });
    const body = JSON.stringify(status);
    if (body !== this.last) { atomic(join(this.root, 'status.json'), { updatedAt: now.toISOString(), ...status }); this.last = body; }
    return added;
  }

  /** Move a request's own status file along when its queue job has started or finished. */
  private follow(id: string, statusPath: string, records: ChannelRecords): void {
    let cur: { state?: string; queueName?: string };
    try { cur = JSON.parse(readFileSync(statusPath, 'utf8')); } catch { return; }
    if (typeof cur.queueName !== 'string' || (cur.state !== 'queued' && cur.state !== 'running')) return;
    const name = cur.queueName;
    const finished = [...records.done].filter((d) => d.name === name).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).pop();
    let next: Record<string, unknown> | undefined;
    if (finished) {
      next = { id, queueName: name, state: finished.outcome === 'passed' ? 'done' : 'failed', ...(finished.reason ? { reason: finished.reason } : {}), finishedAt: finished.finishedAt };
    } else if (cur.state === 'queued' && records.current.some((c) => c.name === name)) {
      next = { id, queueName: name, state: 'running' };
    }
    if (next) atomic(statusPath, next);
  }
}

