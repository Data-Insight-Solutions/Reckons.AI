#!/usr/bin/env npx tsx
/**
 * Optional, per-user file-queue adapter. No HTTP listener and no general shell execution.
 * npm run gen:serve -- --workspace=/path/to/private-workspace
 * The browser must connect the same folder. Each job runs in a separate process so synchronous
 * generation commands cannot prevent heartbeat updates or cancellation of their process group.
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

type Running = { process: ChildProcess; request: GenerationRequest; directory: string };
export class GenerationRunner {
  readonly root: string;
  readonly jobs: string;
  readonly workspaceId: string;
  private running?: Running;
  private stopping = false;
  constructor(workspace: string) {
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
    mkdirSync(join(this.root, 'runner.lock'), { mode: 0o700 });
    writeFileSync(join(this.root, 'runner.lock', 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  }

  tick(): void {
    if (this.stopping) return;
    atomic(join(this.root, 'capabilities.json'), {
      version: 1, workspaceId: this.workspaceId, heartbeat: Date.now(),
      stages: GENERATION_STAGES.map(stage => ({ stage, ...generationAvailability(stage) })),
    });
    if (this.running) {
      if (existsSync(join(this.running.directory, 'cancel.json'))) this.cancelRunning('cancelled');
      return;
    }
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
      if (existsSync(statusPath)) {
        let job: GenerationJob;
        try { job = parseJob(json(statusPath), request); }
        catch {
          // A broken receipt must not block every later request or trigger an automatic rerun.
          atomic(statusPath, { request, state: 'failed', error: 'Job metadata is invalid. Retry to create a new job.' });
          continue;
        }
        if (job.state === 'running') {
          atomic(statusPath, { request, state: 'failed', error: 'Runner interrupted. Retry to create a new job.' });
        }
        if (job.state !== 'queued') continue;
      }
      if (existsSync(join(directory, 'cancel.json'))) {
        atomic(statusPath, { request, state: 'cancelled' });
        continue;
      }
      const capability = generationAvailability(request.stage);
      if (!capability.available) {
        atomic(statusPath, { request, state: 'failed', error: capability.reason });
        continue;
      }
      atomic(statusPath, { request, state: 'running' });
      // The worker's output stays in its private job folder: with stdio ignored, a crash such as a
      // missing package left only "exited without a checked result" and nothing to act on.
      const log = openSync(join(directory, 'worker.log'), 'w', 0o600);
      const child = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, `--worker=${directory}`], {
        detached: true, stdio: ['ignore', log, log],
      });
      closeSync(log);
      const running: Running = { process: child, request, directory };
      this.running = running;
      child.once('error', () => this.finish(running));
      child.once('exit', () => this.finish(running));
      break;
    }
  }
  private finish(running: Running) {
    if (this.running !== running) return;
    const path = join(running.directory, 'status.json');
    let current: GenerationJob | null = null;
    try { current = parseJob(json(path), running.request); } catch { /* missing/broken worker receipt */ }
    if (!current || current.state === 'running') {
      const reason = lastErrorLine(join(running.directory, 'worker.log'));
      atomic(path, {
        request: running.request, state: 'failed',
        error: `Generation process exited without a checked result${reason ? `: ${reason}` : '.'} (log: worker.log in this job's folder)`,
      });
    }
    this.running = undefined;
  }
  private cancelRunning(state: 'cancelled' | 'failed') {
    const running = this.running;
    if (!running) return;
    // SIGKILL reaches sd-cli / Python descendants as well as the worker.
    if (running.process.pid) {
      try { process.kill(-running.process.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    atomic(join(running.directory, 'status.json'), {
      request: running.request, state,
      ...(state === 'failed' ? { error: 'Runner stopped. Retry when it is connected.' } : {}),
    });
    // Wait for exit before another job may start.
  }
  close() {
    if (this.stopping) return;
    this.stopping = true;
    this.cancelRunning('failed');
    rmSync(join(this.root, 'capabilities.json'), { force: true });
    rmSync(join(this.root, 'runner.lock'), { recursive: true, force: true });
  }
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
  const workspace = arg('workspace');
  if (!workspace) throw new Error('Usage: npm run gen:serve -- --workspace=/path/to/private-workspace');
  const runner = new GenerationRunner(workspace);
  const timer = setInterval(() => {
    try { runner.tick(); } catch (e) { console.error(String(e)); }
  }, 2000);
  console.log('Local generation runner ready. Connect this workspace folder in Reckons.AI.');
  const stop = () => { clearInterval(timer); runner.close(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', () => runner.close());
  runner.tick();
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main().catch(e => { console.error(String(e)); process.exitCode = 1; });
}
