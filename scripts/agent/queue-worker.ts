/**
 * npm run agent:queue-worker — work through the local-job queue WHILE A SESSION IS ACTIVE (F74.7).
 *
 * Matt, 2026-09-30: "I don't want to leave on my machine all night for a burst of activity while I
 * sleep." So this never runs on a clock. It runs a job only while the session heartbeat
 * (scripts/agent/session-heartbeat.sh, touched by a Claude Code hook) is fresh. When the heartbeat
 * goes stale it FINISHES the current job, then pauses (a 60 s poll of one file; no GPU use) and
 * resumes when the heartbeat is fresh again. It never starts a job when Ollama is down.
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
 * Usage: npm run agent:queue-worker [-- --idle-minutes=20] [--poll-seconds=60] [--stay]
 * Exits when the queue is empty unless --stay.
 *
 * WEAKNESS, said out loud: job-watch's local-model verdict needs OLLAMA_BASE_URL, which this sets to
 * http://localhost:11434 when unset; a job that merely does not need the GPU (notes-pull) is still
 * held while Ollama is down, because one gate is simpler than a per-job one.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';
import { DEFAULT_IDLE_MINUTES, addJobs, heartbeatFresh, isGpuJob, isPaused, mutateQueue, orderQueue, pickNext, readDone, readHeartbeatMtime, readQueue, readWorker, workerStep, writeWorker, type QueueJob, type WorkerState } from './session-queue.js';
import { readCircuitCache } from './job-state.js';
import { readGpuVerdict } from './session-gpu.js';
import { doneSuccesses, dueAll, heldSchedules, loadRecurring, mergeSuccesses, selectDue } from './session-schedule.js';

const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');

async function ollamaUp(): Promise<boolean> {
  try { return (await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function runJob(job: QueueJob): Promise<number> {
  const jobWatch = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-watch.ts');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...process.execArgv, jobWatch, `--name=${job.name}`, '--', ...job.argv], {
      cwd: job.cwd, stdio: 'inherit', env: { ...process.env, OLLAMA_BASE_URL: OLLAMA },
    });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const num = (k: string, d: number) => { const v = Number(args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1]); return Number.isFinite(v) && v > 0 ? v : d; };
  const idleMinutes = num('idle-minutes', DEFAULT_IDLE_MINUTES);
  const pollMs = num('poll-seconds', 60) * 1000;
  const stay = args.includes('--stay');
  const root = mainCheckoutRoot();
  const other = readWorker();
  if (other?.pid && other.pid !== process.pid) { console.error(`queue-worker: another worker is already running (pid ${other.pid}); only one runs so only one GPU job does`); process.exit(1); }
  let finished = 0;
  let stop = false;
  const bye = () => { stop = true; try { writeWorker({ state: 'empty' }); } catch { /* best effort */ } process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  let lastState: WorkerState | undefined;
  let lastHeld = '';

  while (!stop) {
    const fresh = heartbeatFresh(readHeartbeatMtime(), Date.now(), idleMinutes);
    const up = await ollamaUp();
    if (fresh) {
      const { jobs, successes } = loadRecurring(root);
      const done = readDone();
      const statuses = dueAll(jobs, mergeSuccesses(successes, doneSuccesses(done)), Date.now());
      const held = heldSchedules(done, readCircuitCache(), Date.now());
      const heldNow = [...held].map(([n, why]) => `${n} (${why})`).join('; ');
      if (heldNow !== lastHeld) { if (heldNow) console.log(`queue-worker: holding ${heldNow}`); lastHeld = heldNow; }
      const added = addJobs(selectDue(statuses, [], undefined, 5, held)).add;
      if (added.length) console.log(`queue-worker: enqueued overdue: ${added.map((a) => a.name).join(', ')}`);
    }
    const queue = orderQueue(readQueue());
    // Only ask nvidia-smi when a GPU job could actually start (session active, Ollama up, not paused).
    const gate = fresh && up && !isPaused() && queue.some(isGpuJob) ? await readGpuVerdict() : { ok: true as const };
    const gpuBlocked = gate.ok ? undefined : gate.reason;
    const step = workerStep({ queue, running: false, heartbeatFresh: fresh, ollamaUp: up, manualPause: isPaused(), gpuBlocked });
    if (step.state !== lastState) {
      const say = { 'paused-manual': `paused — PAUSE file present (queue.ts resume); ${queue.length} queued`, 'paused-resources': `paused — ${gpuBlocked}; ${queue.length} queued`, 'paused-idle': `paused — no session activity in ${idleMinutes} min; ${queue.length} queued`, 'paused-ollama-down': `paused — Ollama is down at ${OLLAMA}; ${queue.length} queued`, empty: 'queue empty', working: 'working', ready: 'ready' }[step.state];
      console.log(`queue-worker: ${say}`);
      lastState = step.state;
    }
    if (!step.startJob) {
      writeWorker({ state: step.state, reason: step.reason });
      if (step.state === 'empty' && !stay) return;
      await sleep(pollMs);
      continue;
    }
    const job = pickNext(queue, gpuBlocked)!;
    writeWorker({ state: 'working', job: job.name, index: finished + 1, total: finished + queue.length, });
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
