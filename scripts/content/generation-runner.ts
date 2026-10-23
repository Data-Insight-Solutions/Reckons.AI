#!/usr/bin/env npx tsx
/**
 * Optional, per-user file-queue adapter. No HTTP listener and no general shell execution.
 * npm run gen:serve -- --workspace=/path/to/private-workspace
 * The browser must connect the same folder. gen:serve feeds checked requests into the shared local
 * job queue (scripts/agent/session-queue.ts) and starts a queue worker when none runs; each job runs
 * as `--job=<folder>`, which supervises the generation in its own process group so cancellation
 * reaches the tool.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, copyFileSync, existsSync, openSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  GENERATION_DIR, GENERATION_STAGES, OUTPUT_FILES, parseJob, parseRequest,
  validJobId, validateReceipt, type GenerationJob, type GenerationRequest,
} from '../../src/lib/generation/protocol.js';
import { generationAvailability, generateStage } from './gen-assets.js';
import { addJobs, mutateQueue, newJob, readQueue, readWorker } from '../agent/session-queue.js';

function json(path: string): unknown {
  const bytes = readFileSync(path);
  if (bytes.length > 100_000) throw new Error('Generation metadata is too large');
  return JSON.parse(bytes.toString('utf8'));
}
function atomic(path: string, value: unknown) {
  writeFileSync(`${path}.tmp`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}
function safeDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink()) throw new Error('Generation directories must not be symlinks');
}
function verifiedBytes(path: string, receipt: NonNullable<GenerationJob['receipt']>) {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Generated files must not be symlinks');
  const bytes = readFileSync(path);
  if (bytes.length !== receipt.output.bytes
    || createHash('sha256').update(bytes).digest('hex') !== receipt.output.sha256) {
    throw new Error('Generated file does not match its receipt');
  }
  return bytes;
}

export function prepareParent(jobs: string, request: GenerationRequest, directory: string): void {
  if (!request.parentId) return;
  const parentDir = join(jobs, request.parentId);
  if (lstatSync(parentDir).isSymbolicLink()) throw new Error('Source job must not be a symlink');
  const parent = parseRequest(json(join(parentDir, 'request.json')));
  const job = parseJob(json(join(parentDir, 'status.json')), parent);
  if (parent.id !== request.parentId || parent.spaceId !== request.spaceId || parent.stage !== 'image'
    || job.state !== 'completed' || !job.receipt || existsSync(join(parentDir, 'cancel.json'))) {
    throw new Error('A derivation needs a completed image in the same space');
  }
  const source = join(parentDir, OUTPUT_FILES.image);
  verifiedBytes(source, job.receipt);
  copyFileSync(source, join(directory, OUTPUT_FILES.image));
}

async function worker(directory: string) {
  const request = parseRequest(json(join(directory, 'request.json')));
  if (request.id !== directory.split('/').pop()) throw new Error('Job directory does not match request');
  const save = (job: GenerationJob) => atomic(join(directory, 'status.json'), job);
  try {
    prepareParent(dirname(directory), request, directory);
    if (existsSync(join(directory, 'cancel.json'))) { save({ request, state: 'cancelled' }); return; }
    const receipt = await generateStage(request.stage, {
      slug: request.id, label: 'Generated asset', imagePrompt: request.prompt, videoPrompt: request.prompt,
      seed: request.seed, gaussians: 32768, role: 'node',
    }, directory);
    validateReceipt(receipt, request);
    verifiedBytes(join(directory, receipt.output.file), receipt);
    if (existsSync(join(directory, 'cancel.json'))) save({ request, state: 'cancelled' });
    else save({ request, state: 'completed', receipt });
  } catch (e) {
    // Full tool output stays private beside the request, never in a graph or public artifact.
    writeFileSync(join(directory, 'error.log'), String(e), { mode: 0o600 });
    const stderr = String((e as { stderr?: unknown })?.stderr ?? '').trim().split('\n').pop();
    const message = stderr || (e instanceof Error && !e.message.startsWith('Command failed') ? e.message : 'Generation tool failed. Details are in this job’s error.log.');
    save({ request, state: 'failed', error: message.slice(0, 500) });
  }
}

/** The shared-queue job name for one request. Unique per request, so the circuit breaker never
 *  confuses two prompts, and free of the prompt, which stays in the private workspace. */
export const queueJobName = (request: GenerationRequest) => `gen-${request.stage}-${request.id.slice(0, 8)}`;
const repoRoot = resolve(dirname(import.meta.filename), '..', '..');
const ENQUEUED = 'enqueued.json';

/**
 * The bridge between the browser's private file queue and the shared local-job queue (F166.1.2).
 * It no longer runs generation itself: each checked request becomes one fixed-argv job in the queue
 * that agent:queue-worker drains, so the GPU gate, the circuit breaker and agent:watch cover
 * generation as they cover every other local job. Only typed request fields cross from the
 * browser; the argv is built here and names a job folder, never a prompt or a tool.
 */
export class GenerationRunner {
  readonly root: string;
  readonly jobs: string;
  readonly workspaceId: string;
  private stopping = false;
  private worker?: ChildProcess;
  constructor(workspace: string, private readonly options: { startWorker?: boolean } = {}) {
    const folder = realpathSync(workspace);
    this.root = join(folder, GENERATION_DIR);
    // A private workspace may be git-ignored inside a checkout; public source folders are refused.
    try {
      const repo = execFileSync('git', ['-C', folder, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      try { execFileSync('git', ['-C', repo, 'check-ignore', '-q', join(this.root, 'probe')]); }
      catch { throw new Error('Generation jobs must be outside a Git checkout or in an ignored private workspace'); }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('Generation jobs')) throw e;
    }
    safeDirectory(this.root);
    this.jobs = join(this.root, 'jobs');
    safeDirectory(this.jobs);
    const identityPath = join(this.root, 'workspace-id.json');
    if (!existsSync(identityPath)) atomic(identityPath, randomUUID());
    const identity = json(identityPath);
    if (!validJobId(identity)) throw new Error('Invalid generation workspace identity');
    this.workspaceId = identity;
    // Atomic directory creation prevents two runners from taking the same queue/GPU.
    const lock = join(this.root, 'runner.lock');
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // A runner that died without its exit handler (kill -9, a crash) left its lock behind. Found
      // 2026-10-22: gen:serve then refused to start until the folder was deleted by hand.
      let pid: unknown;
      try { pid = (JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')) as { pid?: unknown }).pid; } catch { /* no owner recorded */ }
      if (lockOwnerAlive(pid)) throw new Error(`Another generation runner (pid ${pid}) is using this workspace. Stop it first.`);
      rmSync(lock, { recursive: true, force: true });
      mkdirSync(lock, { mode: 0o700 });
    }
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  }

  tick(): void {
    if (this.stopping) return;
    atomic(join(this.root, 'capabilities.json'), {
      version: 1, workspaceId: this.workspaceId, heartbeat: Date.now(),
      stages: GENERATION_STAGES.map(stage => ({ stage, ...generationAvailability(stage) })),
    });
    const queued = new Set(readQueue().map(job => job.name));
    let added = false;
    for (const id of readdirSync(this.jobs).sort()) {
      if (!validJobId(id)) continue;
      const directory = join(this.jobs, id);
      if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) continue;
      let request: GenerationRequest;
      try {
        request = parseRequest(json(join(directory, 'request.json')));
        if (request.id !== id) continue;
      } catch { continue; } // The browser may still be closing its atomic writable.
      const statusPath = join(directory, 'status.json');
      const name = queueJobName(request);
      let state: GenerationJob['state'] = 'queued';
      if (existsSync(statusPath)) {
        try { state = parseJob(json(statusPath), request).state; }
        catch {
          // A broken receipt must not block every later request or trigger an automatic rerun.
          atomic(statusPath, { request, state: 'failed', error: 'Job metadata is invalid. Retry to create a new job.' });
          continue;
        }
      }
      if (state !== 'queued' && state !== 'running') continue;
      const enqueued = existsSync(join(directory, ENQUEUED));
      if (state === 'running' || enqueued) {
        // The queue worker removes a job only after its process exits, and the job writes its final
        // status before exiting. Gone from the queue but not final means it died or was refused.
        if (queued.has(name)) {
          if (state === 'queued' && existsSync(join(directory, 'cancel.json'))) this.drop(request, statusPath);
          continue;
        }
        atomic(statusPath, { request, state: 'failed', error: state === 'running'
          ? 'Runner interrupted. Retry to create a new job.'
          : 'The local job queue did not run this job (dropped or refused by its circuit breaker). See agent:watch.' });
        continue;
      }
      if (existsSync(join(directory, 'cancel.json'))) {
        atomic(statusPath, { request, state: 'cancelled' });
        continue;
      }
      if (request.parentId) {
        // A derivation enters the queue only once its source image is done, so the queue itself
        // needs no notion of dependencies and a failed image never reaches a GPU twice.
        const parent = this.parentState(request.parentId);
        if (parent === 'queued' || parent === 'running') continue;
        if (parent !== 'completed') {
          atomic(statusPath, { request, state: 'failed', error: 'Its source image did not complete, so this derivation was not run.' });
          continue;
        }
      }
      const capability = generationAvailability(request.stage);
      if (!capability.available) {
        atomic(statusPath, { request, state: 'failed', error: capability.reason });
        continue;
      }
      addJobs([newJob(name, repoRoot, [process.execPath, '--import', 'tsx', import.meta.filename, `--job=${directory}`], undefined, true, false)]);
      atomic(join(directory, ENQUEUED), { name, at: new Date().toISOString() });
      added = true;
    }
    if (added) this.ensureWorker();
  }
  private parentState(id: string): GenerationJob['state'] | 'missing' {
    try {
      const dir = join(this.jobs, id);
      const parent = parseRequest(json(join(dir, 'request.json')));
      if (existsSync(join(dir, 'cancel.json'))) return 'cancelled';
      return existsSync(join(dir, 'status.json')) ? parseJob(json(join(dir, 'status.json')), parent).state : 'queued';
    } catch { return 'missing'; }
  }
  private drop(request: GenerationRequest, statusPath: string) {
    const name = queueJobName(request);
    mutateQueue((jobs) => {
      const gone = jobs.filter(job => job.name === name);
      return {
        jobs: jobs.filter(job => job.name !== name),
        done: gone.map(job => ({ ...job, finishedAt: new Date().toISOString(), outcome: 'dropped' as const })),
        result: undefined,
      };
    });
    atomic(statusPath, { request, state: 'cancelled' });
  }
  /** Start the shared worker when generation is waiting and none is running. It exits once the
   *  queue is empty, so nothing stays resident after the last job. */
  private ensureWorker() {
    if (this.options.startWorker === false || readWorker() || (this.worker && this.worker.exitCode === null)) return;
    const log = openSync(join(this.root, 'queue-worker.log'), 'a', 0o600);
    this.worker = spawn(process.execPath, ['--import', 'tsx', join(repoRoot, 'scripts/agent/queue-worker.ts')], {
      cwd: repoRoot, detached: true, stdio: ['ignore', log, log],
    });
    closeSync(log);
    this.worker.unref();
  }
  close() {
    if (this.stopping) return;
    this.stopping = true;
    // Jobs already in the shared queue keep running; their results stay readable from the folder.
    rmSync(join(this.root, 'capabilities.json'), { force: true });
    rmSync(join(this.root, 'runner.lock'), { recursive: true, force: true });
  }
}

/**
 * Whether the pid recorded in a runner lock is still a generation runner. Linux reuses pids, so a live
 * pid counts only if its command line still names the runner (the session-queue workerPidAlive rule).
 * Without /proc (macOS) liveness alone decides. EPERM means alive but not ours to signal.
 */
export function lockOwnerAlive(
  pid: unknown,
  alive: (pid: number) => boolean = (p) => { try { process.kill(p, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
  readCmdline: (pid: number) => string = (p) => readFileSync(`/proc/${p}/cmdline`, 'utf8'),
  hasProc: () => boolean = () => existsSync('/proc/self'),
): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  if (!alive(pid)) return false;
  try { return readCmdline(pid).includes('generation-runner'); }
  catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT' || !hasProc(); }
}

/**
 * One queue job: run one request in a child process group and supervise it. The child does the
 * work; this process stays responsive so a cancel.json written by the browser can stop the tool
 * mid-stage. Prints no prompt: job-watch keeps this output in the host's run log. Exit 0 = completed
 * or cancelled, 1 = failed, so the circuit breaker counts real failures.
 */
export async function runQueuedJob(directory: string): Promise<number> {
  const request = parseRequest(json(join(directory, 'request.json')));
  if (request.id !== directory.split('/').pop()) throw new Error('Job directory does not match request');
  const statusPath = join(directory, 'status.json');
  const say = (state: string) => console.log(`generation ${request.id.slice(0, 8)} ${request.stage}: ${state}`);
  if (existsSync(statusPath) && parseJob(json(statusPath), request).state !== 'queued') { say('already handled'); return 0; }
  if (existsSync(join(directory, 'cancel.json'))) { atomic(statusPath, { request, state: 'cancelled' }); say('cancelled'); return 0; }
  const capability = generationAvailability(request.stage);
  if (!capability.available) { atomic(statusPath, { request, state: 'failed', error: capability.reason }); say('failed'); return 1; }
  atomic(statusPath, { request, state: 'running' });
  say('running');
  // The worker's output stays in its private job folder: with stdio ignored, a crash such as a
  // missing package left only "exited without a checked result" and nothing to act on.
  const log = openSync(join(directory, 'worker.log'), 'w', 0o600);
  const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, `--worker=${directory}`], {
    detached: true, stdio: ['ignore', log, log],
  });
  closeSync(log);
  const exited = new Promise<void>(done => { child.once('exit', () => done()); child.once('error', () => done()); });
  const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } } };
  process.once('SIGTERM', kill);
  process.once('SIGINT', kill);
  let cancelled = false;
  const watch = setInterval(() => {
    // SIGKILL reaches sd-cli / Python descendants as well as the worker.
    if (!cancelled && existsSync(join(directory, 'cancel.json'))) { cancelled = true; kill(); }
  }, 1000);
  await exited;
  clearInterval(watch);
  let current: GenerationJob | null = null;
  try { current = parseJob(json(statusPath), request); } catch { /* missing/broken worker receipt */ }
  if (cancelled && current?.state !== 'completed') current = { request, state: 'cancelled' };
  if (!current || current.state === 'running') {
    const reason = lastErrorLine(join(directory, 'worker.log'));
    current = { request, state: 'failed',
      error: `Generation process exited without a checked result${reason ? `: ${reason}` : '.'} (log: worker.log in this job's folder)` };
  }
  atomic(statusPath, current);
  say(current.state);
  return current.state === 'failed' ? 1 : 0;
}

/** The most useful single line of a worker log: the last line naming an error, else the last line. */
export function lastErrorLine(path: string): string {
  let text = '';
  try { text = readFileSync(path, 'utf8').slice(-20_000); } catch { return ''; }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const line = [...lines].reverse().find(l => /error|cannot|not found|failed|traceback/i.test(l) && !/^at /.test(l)) ?? lines.at(-1) ?? '';
  return line.slice(0, 300);
}

async function main() {
  const arg = (key: string) => process.argv.find(v => v.startsWith(`--${key}=`))?.slice(key.length + 3);
  const workerDir = arg('worker');
  if (workerDir) { await worker(resolve(workerDir)); return; }
  const jobDir = arg('job');
  if (jobDir) { process.exitCode = await runQueuedJob(resolve(jobDir)); return; }
  const workspace = arg('workspace');
  if (!workspace) throw new Error('Usage: npm run gen:serve -- --workspace=/path/to/private-workspace');
  const runner = new GenerationRunner(workspace);
  const timer = setInterval(() => {
    try { runner.tick(); } catch (e) { console.error(String(e)); }
  }, 2000);
  console.log('Local generation bridge ready. Connect this workspace folder in Reckons.AI; jobs run through agent:queue-worker.');
  const stop = () => { clearInterval(timer); runner.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('SIGHUP', stop); // the terminal was closed
  process.once('exit', () => runner.close());
  runner.tick();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main().catch(e => { console.error(String(e)); process.exitCode = 1; });
}
