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
 * CROSS-DEVICE MODE (F303.1/.3, only when ChannelOptions.device is given; without it the behavior above
 * is unchanged). Several devices then share this folder, so nothing is shared-written: each device's
 * answers go under job-channel/devices/<device-id>/ (its status.json and requests/<id>.json) and its
 * claims under job-channel/claims/<device-id>/<request-id>.json. A request must then carry the
 * cross-device fields (scripts/agent/lib/cross-device-request.ts); this device matches its measured
 * capabilities (matchCapabilities), claims, applies the fixed claim rule (scripts/agent/lib/job-claims.ts)
 * and only the winner checks the input hashes and queues the job.
 *
 * NOT built here (F303): signatures (another device's request is refused), results and receipts (F303.5),
 * transport providers, the 'not allowed here' verdict from settings. Held reasons come only from broken job chains, not from schedule or back-pressure holds.
 */
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { claimLive, newClaim, parseClaim, renewClaim, resolveClaims, LEASE_MS, type Claim } from './lib/job-claims.js';
import { readCapabilityTerms, validateCrossDeviceRequest, type CapabilityTerms } from './lib/cross-device-request.js';
import { matchCapabilities, type Measured } from './device-capabilities.js';
import { INPUT_WAIT_MS, verifyInputs } from './cross-device-inputs.js';
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

/** This device, as the channel needs it in cross-device mode. */
export type ChannelDevice = {
  /** The opaque device id (deviceStableId). */
  id: string;
  /** What this device measured; undefined = never measured, which satisfies no need. */
  capabilities: Measured | undefined;
  /** Capability terms; read from static/reckons-capabilities.ttl when absent. */
  terms?: CapabilityTerms;
  leaseMs?: number;
  /** A winner waits this long after its claim before queueing, so other devices' claims can arrive by sync. */
  settleMs?: number;
};

export const loadCapabilityTerms = (): CapabilityTerms =>
  readCapabilityTerms(readFileSync(join(repoRoot, 'static', 'reckons-capabilities.ttl'), 'utf8'));

export type ChannelOptions = {
  device?: ChannelDevice;
  /** Queue a job; defaults to the local queue. Injectable so a test can stand in for a device's queue. */
  enqueue?: (job: QueueJob) => boolean;
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
    if (this.opts.device) return this.tickDevice(this.opts.device);
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

  // ── cross-device mode (F303.1, F303.3) ────────────────────────────────────

  private claimsDir(device: string): string { const d = join(this.root, 'claims', device); safeDirectory(join(this.root, 'claims')); safeDirectory(d); return d; }

  /** Every valid claim for a request, read from each device's own folder. A file whose folder is not the
   *  device it names, a symlink, or one that does not parse is ignored (and says nothing: it is not ours). */
  private readClaims(requestId: string, now: Date): Claim[] {
    const base = join(this.root, 'claims');
    if (!existsSync(base)) return [];
    const out: Claim[] = [];
    for (const dev of readdirSync(base)) {
      const p = join(base, dev, `${requestId}.json`);
      try {
        const st = lstatSync(p);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 2000) continue;
        const parsed = parseClaim(JSON.parse(readFileSync(p, 'utf8')), now);
        if (parsed.ok && parsed.claim.device === dev && parsed.claim.requestId === requestId) out.push(parsed.claim);
      } catch { /* absent or mid-write */ }
    }
    return out;
  }

  private tickDevice(device: ChannelDevice): boolean {
    const jobs = this.opts.jobs ?? CHANNEL_JOBS;
    const records = (this.opts.records ?? readRecords)();
    const now = (this.opts.now ?? (() => new Date()))();
    const enqueue = this.opts.enqueue ?? ((j: QueueJob) => addJobs([j]).add.length > 0);
    const terms = device.terms ?? (device.terms = loadCapabilityTerms());
    const leaseMs = device.leaseMs ?? LEASE_MS;
    const settleMs = device.settleMs ?? 15_000;
    const spaces = spacesIn(realpathSync(this.workspace));
    const mine = join(this.root, 'devices', device.id);
    safeDirectory(join(this.root, 'devices')); safeDirectory(mine);
    const answers = join(mine, 'requests');
    safeDirectory(answers);
    const answerPath = (id: string) => join(answers, `${id}.json`);
    const readAnswer = (id: string): { state?: string; queueName?: string } | undefined => { try { return JSON.parse(readFileSync(answerPath(id), 'utf8')); } catch { return undefined; } };
    const writeAnswer = (id: string, body: Record<string, unknown>) => {
      const cur = readAnswer(id);
      if (cur && JSON.stringify(cur) === JSON.stringify({ id, ...body })) return;
      atomic(answerPath(id), { id, ...body });
    };
    const writeClaim = (c: Claim) => { atomic(join(this.claimsDir(device.id), `${c.requestId}.json`), c); };
    let added = false;

    for (const file of readdirSync(this.requests).sort()) {
      if (!file.endsWith('.json') || file.endsWith('.status.json')) continue;
      const id = file.slice(0, -'.json'.length);
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) continue;
      const cur = readAnswer(id);
      if (cur && (cur.state === 'queued' || cur.state === 'running')) { this.followDevice(id, cur, records, answerPath(id), writeClaim, now); continue; }
      if (cur && (cur.state === 'done' || cur.state === 'failed' || cur.state === 'refused')) continue;
      const raw = readRequestFile(this.requests, file);
      if (raw === undefined) continue;
      const verdict = validateCrossDeviceRequest(raw as never, { thisDeviceId: device.id, terms, jobs, spaces, now });
      if (!verdict.ok) { writeAnswer(id, { state: 'refused', reason: verdict.reason }); continue; }
      if (verdict.id !== id) { writeAnswer(id, { state: 'refused', reason: 'the id inside the request must match its file name' }); continue; }
      const match = matchCapabilities(verdict.needs, device.capabilities);
      if (match.verdict === 'cannot-run') { writeAnswer(id, { state: 'cannot-run', reasons: match.reasons }); continue; }

      // INPUTS: sync delivers large files in pieces, so a missing file or a hash that differs NOW is a
      // state to wait in, not a refusal, until the deadline (INPUT_WAIT_MS from createdAt). No claim is
      // taken while waiting (another device may already have the file). A link, a directory or a path
      // leaving the workspace never resolves by waiting and is refused at once.
      const inputs = verifyInputs(this.workspace, verdict.inputs);
      if (!inputs.ok) {
        if (!inputs.waiting) { writeAnswer(id, { state: 'refused', reason: inputs.reason }); continue; }
        if (now.getTime() > Date.parse(verdict.createdAt) + INPUT_WAIT_MS) {
          writeAnswer(id, { state: 'refused', reason: `${inputs.reason}; still not matching after the ${INPUT_WAIT_MS / 60_000} minute wait` });
        } else {
          writeAnswer(id, { state: 'waiting-for-input', path: inputs.path, expected: inputs.expected, ...(inputs.actual ? { actual: inputs.actual } : { actual: 'missing' }) });
        }
        continue;
      }

      // CLAIM: write or renew only our own file, then read everyone's and apply the fixed rule.
      let claims = this.readClaims(id, now);
      const own = claims.find((c) => c.device === device.id);
      if (!own) writeClaim(newClaim(id, device.id, now, leaseMs));
      else if (!own.finished && Date.parse(own.leaseUntil) - now.getTime() < leaseMs / 2) {
        const r = renewClaim(own, device.id, now, leaseMs);
        if (r.ok) writeClaim(r.claim);
      }
      claims = this.readClaims(id, now);
      const res = resolveClaims(claims, now, id);
      if (!res.winner) continue;
      if (res.winner.device !== device.id) { writeAnswer(id, { state: 'backed-off', reason: res.winner.finished ? 'another device already ran this request' : 'another device holds this request' }); continue; }
      if (now.getTime() - Date.parse(res.winner.claimedAt) < settleMs) { writeAnswer(id, { state: 'claimed' }); continue; }

      // WINNER: the inputs were verified before claiming; queue as an ordinary local job.
      const spec = jobs[verdict.job]!;
      const name = channelJobName(verdict.job, verdict.id);
      const job: QueueJob = { ...newJob(name, repoRoot, toArgv(verdict, jobs), undefined, spec.gpu, undefined, undefined, spec.ollama), space: verdict.space };
      if (enqueue(job)) added = true;
      writeAnswer(id, { state: 'queued', queueName: name });
    }
    return added;
  }

  private followDevice(id: string, cur: { state?: string; queueName?: string }, records: ChannelRecords, path: string, writeClaim: (c: Claim) => void, now: Date): void {
    const name = cur.queueName;
    if (typeof name !== 'string') return;
    const finished = [...records.done].filter((d) => d.name === name).sort((a, b) => a.finishedAt.localeCompare(b.finishedAt)).pop();
    const claim = this.readClaims(id, now).find((c) => c.device === this.opts.device!.id);
    if (finished) {
      atomic(path, { id, queueName: name, state: finished.outcome === 'passed' ? 'done' : 'failed', ...(finished.reason ? { reason: finished.reason } : {}), finishedAt: finished.finishedAt });
      if (claim) writeClaim({ ...claim, finished: true });
      return;
    }
    if (cur.state === 'queued' && records.current.some((c) => c.name === name)) atomic(path, { id, queueName: name, state: 'running' });
    // Still ours and unfinished: keep the lease alive so a long job is not taken from a live holder.
    if (claim && !claim.finished) {
      const leaseMs = this.opts.device!.leaseMs ?? LEASE_MS;
      if (!claimLive(claim, now) || Date.parse(claim.leaseUntil) - now.getTime() < leaseMs / 2) {
        const r = renewClaim(claim, this.opts.device!.id, now, leaseMs);
        if (r.ok) writeClaim(r.claim);
      }
    }
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

