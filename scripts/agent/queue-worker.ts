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
 * RAM GUARD (F74.11, after the 2026-11-04 crash; session-ram.ts): a GPU job also waits while system RAM
 * available is low, and EVERY running job is sampled every 3 s. If Ollama's anonymous RAM passes the spill
 * limit (a model loading into RAM instead of the GPU) or available RAM falls under the floor, the job's
 * whole process group is stopped, every model is unloaded and the queue is PAUSED for a person to resume.
 * A job added with --ram-spill (a model too big for VRAM) skips the spill check, never the floor.
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
 * JOB CHAINS (Matt 2026-11-03): a job whose --after predecessor never passed never runs; the
 * worker records it once in the done log as 'blocked' (with the reason) and moves on. A deputy
 * job (argv runs local-claude.sh) in a git worktree is checked for the known mislabel — a stalled
 * deputy that exits 0 used to count as work done: the head before and after the run are recorded,
 * and a clean exit that moved nothing is 'no-commit', not 'passed', and satisfies no chain link.
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
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';
import { addJobs, chainBlocked, chainStallReason, isGpuJob, isPaused, setPaused, mutateQueue, needsOllama, newJob, orderQueue, pickNext, readDone, readQueue, readWorker, workerStep, writeWorker, type DoneJob, type QueueJob, type WorkerState } from './session-queue.js';
import { readCircuitCache } from './job-state.js';
import { readGpuVerdict } from './session-gpu.js';
import { loadRamLimits, ramStartVerdict, ramWatchVerdict, readRamSample, unloadOllamaModels, type RamLimits } from './session-ram.js';
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

/** A deputy job runs scripts/agent/local-claude.sh; for those, a clean exit is not proof the work happened. */
const isDeputy = (job: QueueJob): boolean => job.argv.some((a) => /local-claude\.sh$/.test(a));

/** The head commit in the job's folder; '' when it is not a working tree with commits (the no-commit gate then cannot apply). */
const gitHead = (cwd: string): string => {
  try { return spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).stdout.trim(); }
  catch { return ''; }
};

/** The running job's process group (its pid), so a stop or the worker's own exit reaches every process of the job. */
let activeGroup: number | undefined;
const killGroup = (pid: number, sig: NodeJS.Signals): void => { try { process.kill(-pid, sig); } catch { /* already gone */ } };

/** How often the RAM guard samples a running job. A spill fills about 0.45 GB/s (session-ram.ts). */
const RAM_WATCH_MS = 3000;

type RunResult = { code: number; guard?: string };

/**
 * Runs one job through job-watch and watches system RAM while it runs (F74.11). A RAM guard verdict
 * stops the whole job: SIGTERM to its process group, SIGKILL 5 s later if anything is left.
 */
function runJob(job: QueueJob, limits: RamLimits): Promise<RunResult> {
  const jobWatch = path.join(path.dirname(fileURLToPath(import.meta.url)), 'job-watch.ts');
  return new Promise((resolve) => {
    // detached = the job gets its own process group. job-watch passes SIGTERM only to its direct child, and a
    // `bash -c "npx tsx …"` chain can leave the grandchild holding the Ollama request alive; a group kill reaches it,
    // and closing that request is what makes Ollama abort a load in progress (journal, 2026-11-04 12:39:07).
    const child = spawn(process.execPath, [...process.execArgv, jobWatch, `--name=${job.name}`, '--', ...job.argv], {
      // A job that does not use Ollama gets no model verdict either: loading a reader model between
      // two generation stages would only compete with the next stage for VRAM.
      cwd: job.cwd, stdio: 'inherit', env: { ...process.env, OLLAMA_BASE_URL: needsOllama(job) ? OLLAMA : '' }, detached: true,
    });
    activeGroup = child.pid;
    let guard: string | undefined;
    const tick = setInterval(() => {
      if (guard || child.pid === undefined) return;
      const v = ramWatchVerdict(readRamSample(), limits, job.ramSpill === true);
      if (v.ok) return;
      guard = v.reason;
      console.error(`queue-worker: RAM GUARD: ${v.reason}. Stopping ${job.name}.`);
      const pid = child.pid;
      killGroup(pid, 'SIGTERM');
      setTimeout(() => { if (child.exitCode === null && child.signalCode === null) killGroup(pid, 'SIGKILL'); }, 5000).unref();
    }, RAM_WATCH_MS);
    let settled = false;
    const done = (code: number) => { if (settled) return; settled = true; clearInterval(tick); activeGroup = undefined; resolve({ code, guard }); };
    child.on('error', () => done(127));
    child.on('close', (code) => done(code ?? 1));
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
    // The job runs in its own process group (runJob), so a Ctrl-C to the worker no longer reaches it; stop it here.
    if (activeGroup !== undefined) killGroup(activeGroup, 'SIGTERM');
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
  // First-pass schedules enqueue ONCE per worker start (= session activation). Without this set they were
  // re-added on every poll after each run finished, so a 2h schedule ran back to back.
  const firstPassDone = new Set<string>();

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
      // FIRST-PASS jobs: run immediately on first session activation regardless of interval.
      const firstPassJobs = jobs.filter((j) => j.firstPass && !held.has(j.name) && !firstPassDone.has(j.name));
      for (const j of firstPassJobs) firstPassDone.add(j.name);
      const convertedFirst = firstPassJobs.map((j) => newJob(j.name, j.cwd, j.argv, 5, j.gpu));
      const addedFirst = addJobs(convertedFirst).add;
      if (addedFirst.length) console.log(`queue-worker: enqueued first-pass: ${addedFirst.map((a) => a.name).join(', ')}`);
      // Then the usual overdue-due jobs (respecting intervals).
      const added = addJobs(selectDue(statuses, [], undefined, 5, held)).add;
      if (added.length) console.log(`queue-worker: enqueued overdue: ${added.map((a) => a.name).join(', ')}`);
    }
    // JOB CHAINS: a job whose predecessor finished without passing can never run as things stand.
    // Record it ONCE, 'blocked' with the reason, and take it out of the queue — re-running the
    // predecessor is the user's call. Drained before classification so the state the window shows is
    // about what is still live, and so a drained queue reads as empty on the next pass.
    {
      const blocked = chainBlocked(readQueue(), readDone());
      if (blocked.length) {
        const gone = new Set(blocked.map((b) => b.job.id));
        mutateQueue((jobs) => ({
          jobs: jobs.filter((j) => !gone.has(j.id)),
          done: blocked.map(({ job, reason }) => ({ ...job, finishedAt: new Date().toISOString(), outcome: 'blocked' as const, reason })),
          result: undefined,
        }));
        for (const b of blocked) console.log(`queue-worker: ${b.job.name} blocked — ${b.reason}`);
      }
    }
    const queue = orderQueue(readQueue());
    // Only ask nvidia-smi when a GPU job could actually start (not paused, and Ollama up if it needs it).
    const checkGpu = !isPaused() && queue.some((j) => isGpuJob(j) && (up || !needsOllama(j)));
    const ramLimits = loadRamLimits();
    const gate = checkGpu ? await readGpuVerdict() : { ok: true as const };
    // F74.11: an idle GPU is not enough; a GPU job also needs system RAM free in case the model lands there.
    const ram = checkGpu && gate.ok ? ramStartVerdict(readRamSample().mem, ramLimits) : { ok: true as const };
    const gpuBlocked = !gate.ok ? gate.reason : !ram.ok ? ram.reason : undefined;
    const doneLog = readDone();
    const step = workerStep({ queue, running: false, ollamaUp: up, manualPause: isPaused(), gpuBlocked, done: doneLog });
    if (step.state !== lastState) {
      const say = { 'paused-manual': `paused — PAUSE file present (queue.ts resume); ${queue.length} queued`, 'paused-resources': `paused — ${gpuBlocked}; ${queue.length} queued`, 'paused-broken-chain': `paused — ${step.reason ?? 'a chain is waiting on itself'}; ${queue.length} queued`, 'paused-ollama-down': `paused — Ollama is down at ${OLLAMA}; ${queue.length} queued`, empty: 'queue empty', working: 'working', ready: 'ready' }[step.state];
      console.log(`queue-worker: ${say}`);
      lastState = step.state;
    }
    if (!step.startJob) {
      writeWorker({ state: step.state, reason: step.reason, held: heldList });
      if (step.state === 'empty' && !stay) return;
      await sleep(pollMs);
      continue;
    }
    const job = pickNext(queue, gpuBlocked, doneLog, queue, up);
    if (!job) { await sleep(pollMs); continue; } // only waiting jobs left (a chain cycle); the next pass says so
    writeWorker({ state: 'working', job: job.name, index: finished + 1, total: finished + queue.length, held: heldList });
    // 'passed' must mean the work happened. A deputy job runs in a worktree: a clean exit that left
    // the head unchanged is a stalled deputy (exit 0 was its failure mode), recorded no-commit.
    const deputy = isDeputy(job);
    const headBefore = deputy ? gitHead(job.cwd) : '';
    const { code, guard } = await runJob(job, ramLimits);
    finished++;
    let outcome: DoneJob['outcome'] = code === 0 ? 'passed' : code === 3 ? 'refused' : 'failed';
    let reason: string | undefined;
    if (guard) {
      // The model server is in a state that put weights in RAM (on 2026-11-04 a llama-server without its CUDA
      // backend); the next job would meet the same. Unload, pause, and leave the resume to a person.
      const unloaded = await unloadOllamaModels(OLLAMA);
      setPaused(true);
      outcome = 'failed';
      reason = `RAM guard stopped it: ${guard}. Unloaded ${unloaded.length ? unloaded.join(', ') : 'nothing resident'}; queue paused. Check the Ollama journal (journalctl -u ollama), restart Ollama if the GPU backend did not load, then: npx tsx scripts/agent/queue.ts resume`;
    }
    let headAfter: string | undefined;
    if (deputy && headBefore) {
      headAfter = gitHead(job.cwd) || undefined;
      if (outcome === 'passed' && headAfter === headBefore) {
        outcome = 'no-commit';
        reason = `deputy exited clean but no new commit: head ${headBefore.slice(0, 8)} unchanged in ${job.cwd}`;
      }
    }
    mutateQueue((jobs) => ({
      jobs: jobs.filter((j) => j.id !== job.id),
      done: [{ ...job, finishedAt: new Date().toISOString(), outcome, exitCode: code, ...(reason ? { reason } : {}), ...(headBefore ? { headBefore } : {}), ...(headAfter ? { headAfter } : {}) }],
      result: undefined,
    }));
    if (reason) console.log(`queue-worker: ${job.name} ${outcome} — ${reason}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) void main();
