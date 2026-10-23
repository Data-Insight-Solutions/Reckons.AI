/**
 * npm run agent:queue-worker — work through the shared local-job queue (F74.7, F166.1.2).
 *
 * It never runs on a clock: it drains what is queued and exits when the queue is empty (unless
 * --stay). Matt removed the active-Claude-session gate on 2026-10-23, so it no longer waits for a
 * session heartbeat; stop it, or create the PAUSE file, to keep the machine idle. It never starts a
 * job that uses Ollama while Ollama is down; a job queued with ollama:false (generation) still runs.
 *
 * Before STARTING a GPU job it checks the GPU (session-gpu.ts: VRAM, temperature, load that is not
 * Ollama's) and waits (paused-resources) rather than pile on; it fails closed if nvidia-smi fails.
 * A PAUSE file (queue.ts pause) stops it starting anything. Only one worker may run, so only one
 * GPU job runs at a time.
 *
 * Each job runs through job-watch.ts, so the circuit breaker and the TTL run report apply. A job
 * the breaker refuses (exit 3) is recorded as refused and leaves the queue, and its schedule is
 * held (heldSchedules) until the breaker is reset; any failed or refused schedule rests 30 min.
 * Each pass it also enqueues recurring jobs that are overdue (session-schedule.ts), once each.
 *
 * LOCAL GENERATION (F166.1.2). With --workspace=<folder> (or RECKONS_GEN_WORKSPACE) it also serves
 * that folder to the browser: every 2 s it advertises which generation stages this machine can run
 * and turns each checked request into a queued job (scripts/content/generation-runner.ts). That used
 * to be a second long-running command (gen:serve); `npm run gen:serve` is now this worker with a
 * workspace. Serving a workspace implies --stay, since the browser can ask at any time.
 *
 * --no-recurring drains only what is queued (generation, hand-added jobs) and never enqueues recurring
 * schedules.
 *
 * Usage: npm run agent:queue-worker [-- --poll-seconds=60] [--stay] [--workspace=<folder>] [--no-recurring]
 * Exits when the queue is empty unless --stay or a workspace is served.
 *
 * WEAKNESS, said out loud: job-watch's local-model verdict needs OLLAMA_BASE_URL, which this sets to
 * http://localhost:11434 when unset. A job queued with ollama:false runs with it cleared, so its run
 * report carries script facts only. Jobs default to needing Ollama, so a job that does not
 * (notes-pull) is still held while Ollama is down until it is queued with --no-ollama.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';
import { addJobs, isGpuJob, isPaused, mutateQueue, needsOllama, orderQueue, pickNext, readDone, readQueue, readWorker, workerStep, writeWorker, type QueueJob, type WorkerState } from './session-queue.js';
import { readCircuitCache } from './job-state.js';
import { readGpuVerdict } from './session-gpu.js';
import { backlogHolds, DEFAULT_HOLD_UNREVIEWED, doneSuccesses, dueAll, heldSchedules, loadRecurring, mergeSuccesses, selectDue } from './session-schedule.js';
import { loadDeviceConfig } from './device-config.js';
import { GenerationRunner } from '../content/generation-runner.js';
import { openByProducer, tallyWorkspace } from '../offline/lib/proposal-tally.js';

const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');

async function ollamaUp(): Promise<boolean> {
  try { return (await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

/** A poll the generation bridge can cut short, so a job the browser just asked for starts now. */
let wakeNow: (() => void) | undefined;
const sleep = (ms: number) => new Promise<void>((r) => { const t = setTimeout(r, ms); wakeNow = () => { clearTimeout(t); r(); }; });

function runJob(job: QueueJob): Promise<number> {
  const jobWatch = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-watch.ts');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, jobWatch, `--name=${job.name}`, '--', ...job.argv], {
      // A job that does not use Ollama gets no model verdict either: loading a reader model between
      // two generation stages would only compete with the next stage for VRAM.
      cwd: job.cwd, stdio: 'inherit', env: { ...process.env, OLLAMA_BASE_URL: needsOllama(job) ? OLLAMA : '' },
    });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** Open proposals per producer, recounted at most every 10 minutes: it parses every workspace graph. */
let backlogCache: { at: number; open: Map<string, number> } | undefined;
function backlog(root: string, now = Date.now()): Map<string, number> {
  if (!backlogCache || now - backlogCache.at > 10 * 60_000) {
    try { backlogCache = { at: now, open: openByProducer(tallyWorkspace(root).tallies) }; }
    catch { backlogCache = { at: now, open: new Map() }; } // an unreadable workspace holds nothing, never everything
  }
  return backlogCache.open;
}
const holdLimit = (): number => {
  try { const v = loadDeviceConfig().thresholds.holdUnreviewed?.limit; return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_HOLD_UNREVIEWED; }
  catch { return DEFAULT_HOLD_UNREVIEWED; }
};
let heldList: string[] = [];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (k: string, d: number) => { const v = Number(args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]); return Number.isFinite(v) && v > 0 ? v : d; };
  const pollMs = num('poll-seconds', 60) * 1000;
  const workspace = args.find((a) => a.startsWith('--workspace='))?.slice('--workspace='.length) || process.env.RECKONS_GEN_WORKSPACE;
  const stay = args.includes('--stay') || !!workspace;
  const recurring = !args.includes('--no-recurring');
  const root = mainCheckoutRoot();
  const other = readWorker();
  if (other?.pid && other.pid !== process.pid) { console.error(`queue-worker: another worker is already running (pid ${other.pid}); only one runs so only one GPU job does`); process.exit(1); }
  // Ticks on its own timer: the browser rejects a capability heartbeat older than 30 s, and the main
  // loop can be busy for minutes running a job.
  const generation = workspace ? new GenerationRunner(path.resolve(workspace)) : undefined;
  const genTimer = generation ? setInterval(() => {
    try { if (generation.tick()) wakeNow?.(); } catch (e) { console.error(`queue-worker: generation: ${String(e)}`); }
  }, 2000) : undefined;
  if (generation) { generation.tick(); console.log(`queue-worker: serving local generation for ${path.resolve(workspace!)} — connect that folder in Reckons.AI`); }
  let finished = 0;
  let stop = false;
  const bye = () => {
    stop = true;
    if (genTimer) clearInterval(genTimer);
    generation?.close();
    try { writeWorker({ state: 'empty' }); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  process.on('SIGHUP', bye); // the terminal was closed
  let lastState: WorkerState | undefined;
  let lastHeld = '';

  while (!stop) {
    const up = await ollamaUp();
    if (recurring) {
      const { jobs, successes } = loadRecurring(root);
      const done = readDone();
      const statuses = dueAll(jobs, mergeSuccesses(successes, doneSuccesses(done)), Date.now());
      // Back-pressure first, then breaker and backoff holds (their reasons win for the same job).
      const held = new Map([...backlogHolds(jobs, backlog(root), holdLimit()), ...heldSchedules(done, readCircuitCache(), Date.now())]);
      heldList = [...held].map(([n, why]) => `${n.replace(/^sched:/, '')}: ${why}`);
      const heldNow = [...held].map(([n, why]) => `${n} (${why})`).join('; ');
      if (heldNow !== lastHeld) { if (heldNow) console.log(`queue-worker: holding ${heldNow}`); lastHeld = heldNow; }
      const added = addJobs(selectDue(statuses, [], undefined, 5, held)).add;
      if (added.length) console.log(`queue-worker: enqueued overdue: ${added.map((a) => a.name).join(', ')}`);
    }
    const queue = orderQueue(readQueue());
    // Only ask nvidia-smi when a GPU job could actually start (not paused, and Ollama up if it needs it).
    const gate = !isPaused() && queue.some((j) => isGpuJob(j) && (up || !needsOllama(j))) ? await readGpuVerdict() : { ok: true as const };
    const gpuBlocked = gate.ok ? undefined : gate.reason;
    const step = workerStep({ queue, running: false, ollamaUp: up, manualPause: isPaused(), gpuBlocked });
    if (step.state !== lastState) {
      const say = { 'paused-manual': `paused — PAUSE file present (queue.ts resume); ${queue.length} queued`, 'paused-resources': `paused — ${gpuBlocked}; ${queue.length} queued`, 'paused-ollama-down': `paused — Ollama is down at ${OLLAMA}; ${queue.length} queued`, empty: 'queue empty', working: 'working', ready: 'ready' }[step.state];
      console.log(`queue-worker: ${say}`);
      lastState = step.state;
    }
    if (!step.startJob) {
      writeWorker({ state: step.state, reason: step.reason, held: heldList });
      if (step.state === 'empty' && !stay) return;
      await sleep(pollMs);
      continue;
    }
    const job = pickNext(queue, gpuBlocked, up)!;
    writeWorker({ state: 'working', job: job.name, index: finished + 1, total: finished + queue.length, held: heldList });
    const code = await runJob(job);
    finished++;
    mutateQueue((jobs) => ({
      jobs: jobs.filter((j) => j.id !== job.id),
      done: [{ ...job, finishedAt: new Date().toISOString(), outcome: code === 0 ? 'passed' : code === 3 ? 'refused' : 'failed', exitCode: code }],
      result: undefined,
    }));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main();
