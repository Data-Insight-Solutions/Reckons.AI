/**
 * npm run agent:watch — what the local models are doing, right now and today (F74.7).
 *
 * Local runs are shell commands, not Claude Code agents, so they never appear in Claude Code's agent
 * list and a background one is invisible. This is the window onto them. It answers, in order:
 *   1. Is Ollama up, and which models are loaded (VRAM, context, when they unload)?
 *   2. How busy are the GPUs?
 *   3. Has ANYTHING asked a local model for something lately? — read from the Ollama server log, so
 *      it counts every caller (the app, code-review.ts, another agent), not only the panel. A long
 *      silence is reported as silence, because "no local use at all" is the failure it exists to show.
 *   4. The local panel's runs: progress, disagreements so far, and the latest answers with reasons.
 *   5. JOBS (scripts/agent/job-watch.ts): running now with attempt n/max, the last 5 finished, and any
 *      OPEN CIRCUIT (a job that failed the same way max-attempts times and is now refused).
 *      The task queue (runner.ts) is NOT shown: that file is a top-level script that process.exit()s
 *      on import, so there is no side-effect-free reader to call.
 *
 * Usage:
 *   npm run agent:watch                 live, refreshing every 2 s (Ctrl-C to quit)
 *   npm run agent:watch -- --once       one snapshot, then exit
 *   npm run agent:watch -- --detail     more answers per run, with full reasons
 *   npm run agent:watch -- --statusline one short line, for a status bar
 *
 * The status line must return at once, and reading the day's Ollama log costs ~2 s (measured
 * 2026-09-30), so --statusline reads a CACHED last-request time and, when the cache is over a
 * minute old, refreshes it in a detached process that the status line never waits for.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MAX_ATTEMPTS, hyperlink, jobLink, openCircuits, readCircuitCache, readCurrent, readRuns, type CurrentJob, type HistRun } from './job-state.js';
import { attemptLevel, classify, elapsedLevel, fitArt, LEGEND, loadThresholds, median, TURTLE_FRAMES, worst, type Level, type Thresholds } from './watch-render.js';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';
import { START_COMMAND, queueSegment, readDone, readQueueView, type QueueView } from './session-queue.js';
import { doneSuccesses, dueAll, dueLabel, loadRecurring, mergeSuccesses, type Due } from './session-schedule.js';
import { ago, eventLogPath, foldRuns, parseGinLine, readEvents, type OllamaRequest, type RunView } from './local-activity.js';

const OLLAMA = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/+$/, '');

export type LoadedModel = { name: string; vramBytes: number; contextLength?: number; expiresAt?: string };
export type Gpu = { index: number; name: string; util: number; usedMiB: number; totalMiB: number };

export type Snapshot = {
  ollama: { up: boolean; version?: string; loaded: LoadedModel[] };
  gpus: Gpu[];
  /** null when the server log could not be read on this machine — unknown, not empty. */
  requests: OllamaRequest[] | null;
  runs: RunView[];
  jobs?: JobsView;
  /** The session-queue worker's state (F74.7). Absent in old callers. */
  queue?: QueueView;
  /** Recurring jobs and when each is due; absent in --statusline, which reads no TTL. */
  due?: Due[];
};

export type JobsView = {
  running: CurrentJob[];
  finished: HistRun[];
  circuits: { name: string; count: number; signature: string }[];
  /** Median duration (ms) of each job's earlier PASSED runs; absent in --statusline, which reads no history. */
  medians?: Record<string, number>;
  failuresLastHour?: number;
};

export function jobsView(): JobsView {
  const all = readRuns();
  const durations = new Map<string, number[]>();
  for (const r of all) if (r.name && r.status === 'passed' && r.endedAt) durations.set(r.name, [...(durations.get(r.name) ?? []), r.endedAt.getTime() - r.startedAt.getTime()]);
  const medians: Record<string, number> = {};
  for (const [n, d] of durations) {
    const m = median(d);
    if (m !== undefined && d.length >= 2) medians[n] = m;
  }
  const hourAgo = Date.now() - 3_600_000;
  return {
    running: readCurrent(),
    finished: all.filter((r) => r.status !== 'reset').slice(-5),
    circuits: openCircuits(all, DEFAULT_MAX_ATTEMPTS),
    medians,
    failuresLastHour: all.filter((r) => r.status === 'failed' && r.startedAt.getTime() >= hourAgo).length,
  };
}

async function ollamaState(): Promise<Snapshot['ollama']> {
  try {
    const [v, ps] = await Promise.all([
      fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(2000) }),
      fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(2000) }),
    ]);
    const version = ((await v.json()) as { version?: string }).version;
    const models = ((await ps.json()) as { models?: { name: string; size_vram: number; context_length?: number; expires_at?: string }[] }).models ?? [];
    return { up: true, version, loaded: models.map((m) => ({ name: m.name, vramBytes: m.size_vram, contextLength: m.context_length, expiresAt: m.expires_at })) };
  } catch {
    return { up: false, loaded: [] };
  }
}

function gpus(): Gpu[] {
  const r = spawnSync('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.trim().split('\n').map((l) => {
    const [index, name, util, used, total] = l.split(',').map((x) => x.trim());
    return { index: Number(index), name: name.replace(/^NVIDIA (GeForce )?/, ''), util: Number(util), usedMiB: Number(used), totalMiB: Number(total) };
  });
}

function serverRequests(): OllamaRequest[] | null {
  const r = spawnSync('journalctl', ['-u', 'ollama', '--since', 'today', '-o', 'cat', '--no-pager', '-g', 'GIN'], { encoding: 'utf8', timeout: 4000, maxBuffer: 32 * 1024 * 1024 });
  // journalctl exits 1 when the grep matches nothing; that is an empty day, not an unreadable log.
  if (r.error || (r.status !== 0 && r.status !== 1)) return null;
  return (r.stdout ?? '').split('\n').map(parseGinLine).filter((x): x is OllamaRequest => x !== null);
}

const CACHE_MAX_AGE_MS = 60_000;
const cachePath = () => join(dirname(eventLogPath()), 'requests-cache.json');

type RequestCache = { checkedAt: string; today: number; last?: { at: string; status: number; seconds: number; method: string; path: string }; unreadable?: boolean };

function writeRequestCache(): void {
  const reqs = serverRequests();
  const last = reqs?.[reqs.length - 1];
  const cache: RequestCache = reqs === null
    ? { checkedAt: new Date().toISOString(), today: 0, unreadable: true }
    : { checkedAt: new Date().toISOString(), today: reqs.length, last: last ? { ...last, at: last.at.toISOString() } : undefined };
  mkdirSync(dirname(cachePath()), { recursive: true, mode: 0o700 });
  writeFileSync(cachePath(), JSON.stringify(cache), { mode: 0o600 });
}

/** The cached requests, or null when unknown. Starts a background refresh when stale; never waits. */
function cachedRequests(): OllamaRequest[] | null {
  const path = cachePath();
  let cache: RequestCache | undefined;
  try {
    if (existsSync(path)) cache = JSON.parse(readFileSync(path, 'utf8')) as RequestCache;
  } catch {
    /* rewritten below */
  }
  const stale = !cache || Date.now() - statSync(path).mtimeMs > CACHE_MAX_AGE_MS;
  if (stale) {
    try {
      spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), '--refresh-cache'], { detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* the next redraw tries again */
    }
  }
  if (!cache || cache.unreadable) return null;
  return cache.last ? [{ ...cache.last, at: new Date(cache.last.at) }] : [];
}

/** The worker file does not know the attempt; job-watch's current.json does. */
function withAttempt(q: QueueView): QueueView {
  if (q.kind !== 'working') return q;
  const cur = readCurrent().find((c) => c.name === q.job);
  return cur ? { ...q, attempt: cur.attempt, maxAttempts: cur.maxAttempts } : q;
}

export async function snapshot(): Promise<Snapshot> {
  const [ollama] = await Promise.all([ollamaState()]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const runs = foldRuns(readEvents()).filter((r) => !r.finished || new Date(r.startedAt) >= today);
  let due: Due[] | undefined;
  try {
    const { jobs, successes } = loadRecurring(mainCheckoutRoot());
    due = dueAll(jobs, mergeSuccesses(successes, doneSuccesses(readDone())), Date.now());
  } catch { /* an unreadable schedule graph is shown as no DUE line, not a crash */ }
  return { ollama, gpus: gpus(), requests: serverRequests(), runs, jobs: jobsView(), queue: withAttempt(readQueueView(ollama.up)), due };
}

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');
const byLevel = (lv: Level, s: string) => (lv === 'bad' ? red(s) : lv === 'warn' ? yellow(s) : s);
let swimFrame = 0;

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const secs = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`);

function until(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const s = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  return s <= 0 ? 'unloading' : s < 90 ? `unloads in ${s}s` : `unloads in ${Math.round(s / 60)}m`;
}

export type RenderOpts = { detail?: boolean; thresholds?: Thresholds; /** terminal columns; art only when given */ width?: number; frame?: number };

export function render(s: Snapshot, now = new Date(), opts: RenderOpts = {}): string {
  const th = opts.thresholds ?? loadThresholds();
  const levels: Level[] = [];
  /** Colour `text` by `lv` and remember the level, so the turtle's mood is the worst thing on screen. */
  const lvl = (lv: Level, text: string) => (levels.push(lv), byLevel(lv, text));
  const out: string[] = [];
  out.push(`${bold('LOCAL MODELS')}  ${dim(now.toLocaleTimeString())}  ${dim('· npm run agent:watch · Ctrl-C quits')}`);
  out.push(...renderQueue(s.queue, s.due, lvl, th), '');

  if (!s.ollama.up) out.push(`${bold('OLLAMA')}  ${lvl('bad', `DOWN — nothing answers at ${OLLAMA}`)}`);
  else {
    out.push(`${bold('OLLAMA')}  v${s.ollama.version ?? '?'} at ${OLLAMA.replace(/^https?:\/\//, '')} · ${green('up')}`);
    if (s.ollama.loaded.length === 0) out.push(`  ${dim('no model loaded')}`);
    for (const m of s.ollama.loaded) {
      out.push(`  loaded ${bold(m.name)}  ${gb(m.vramBytes)} VRAM${m.contextLength ? ` · ctx ${m.contextLength}` : ''} · ${dim(until(m.expiresAt, now))}`);
    }
  }

  if (s.gpus.length) {
    out.push(`${bold('GPU')}     ${s.gpus.map((g) => `${g.index}: ${g.name} ${lvl(classify(g.util, th.gpuUtil), `${g.util}%`)} ${lvl(classify((g.usedMiB / g.totalMiB) * 100, th.vramPct), `${(g.usedMiB / 1024).toFixed(1)}/${(g.totalMiB / 1024).toFixed(1)} GB`)}`).join(' · ')}`);
  }

  out.push('');
  out.push(`${bold('REQUESTS')} ${dim('every caller, from the Ollama server log')}`);
  if (s.requests === null) out.push(`  ${dim('server log not readable here (journalctl -u ollama) — callers other than the panel are not visible')}`);
  else if (s.requests.length === 0) out.push(`  ${yellow('none today — no local model has been asked anything')}`);
  else {
    const hourAgo = now.getTime() - 3_600_000;
    const lastHour = s.requests.filter((r) => r.at.getTime() >= hourAgo);
    const last = s.requests[s.requests.length - 1];
    const busy = s.requests.reduce((t, r) => t + r.seconds, 0);
    const p50 = median(s.requests.map((r) => r.seconds));
    out.push(`  today ${s.requests.length} · last hour ${lastHour.length} · ${secs(busy * 1000)} of model time · latency p50 ${lvl(classify(p50, th.latencySec), `${(p50 ?? 0).toFixed(1)}s`)}`);
    const idleMs = now.getTime() - last.at.getTime();
    const lastLine = `last ${ago(last.at, now)}: ${last.method} ${last.path} ${lvl(classify(last.seconds, th.latencySec), `${last.seconds.toFixed(1)}s`)}${last.status === 200 ? '' : red(` ${last.status}`)}`;
    out.push(`  ${idleMs > 30 * 60_000 ? yellow(`idle — ${lastLine}`) : lastLine}`);
    const byPath = new Map<string, number>();
    for (const r of s.requests) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
    out.push(`  ${dim([...byPath.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ×${n}`).join(' · '))}`);
  }

  out.push('');
  out.push(`${bold('PANEL RUNS')} ${dim(`today · scripts/agent/local-panel.ts · ${eventLogPath().replace(process.env.HOME ?? '~', '~')}`)}`);
  if (s.runs.length === 0) out.push(`  ${dim('none today')}`);
  const perRun = opts.detail ? 12 : 4;
  for (const r of s.runs.slice(opts.detail ? -6 : -3)) {
    const models = r.models.map((m) => m.split(':')[0]).join('+');
    if (!r.finished) {
      const elapsed = now.getTime() - new Date(r.startedAt).getTime();
      const eta = r.done > 0 ? (elapsed / r.done) * (r.total - r.done) : undefined;
      if (r.done === 0) {
        // A cold model takes 10-30 s to load; say so, or 0/N reads as a hang.
        const warm = r.models.some((m) => s.ollama.loaded.some((l) => l.name === m));
        out.push(`  ${yellow('▶')} ${bold(r.task)}  0/${r.total} votes · ${models} · ${secs(elapsed)} · ${dim(warm ? 'waiting for the first answer' : 'loading the model into VRAM')}`);
        continue;
      }
      out.push(`  ${yellow('▶')} ${bold(r.task)}  ${r.done}/${r.total} votes · ${r.disagreements ? yellow(`${r.disagreements} disagreeing`) : '0 disagreeing'}${r.errors ? red(` · ${r.errors} errors`) : ''} · ${models} · ${secs(elapsed)}${eta !== undefined ? dim(` · ~${secs(eta)} left`) : ''}`);
    } else if (r.abandoned) {
      out.push(`  ${red('✗')} ${bold(r.task)}  ${r.done}/${r.total} votes · ${red('abandoned')} (no run-end; process gone) · ${models} · ${dim(ago(r.startedAt, now))}`);
    } else {
      const c = r.counts ?? {};
      out.push(`  ${r.failed ? red('✗') : green('✓')} ${bold(r.task)}  ${r.done} votes · unanimous ${c.unanimous ?? 0} · majority ${c.majority ?? 0} · split ${c.split ?? 0}${c.failed ? red(` · failed ${c.failed}`) : ''} · ${models} · ${secs(r.ms ?? 0)} · ${dim(ago(r.startedAt, now))}`);
      if (r.resultPath) out.push(`     ${dim(`→ ${r.resultPath}`)}`);
    }
    for (const v of r.recent.slice(-perRun)) {
      const answer = v.error ? red(`ERROR ${v.error.slice(0, 60)}`) : bold(v.value ?? '?');
      const why = v.reason ? dim(` "${opts.detail ? v.reason : v.reason.slice(0, 70)}"`) : '';
      out.push(`     ${dim(v.model.split(':')[0])} ${v.item.slice(-48)} → ${answer}${why}`);
    }
  }
  if (s.jobs) out.push('', ...renderJobs(s.jobs, now, undefined, th, lvl));
  out.push('', dim(LEGEND));
  const art = fitArt(opts.width, opts.frame ?? 0, worst(levels));
  return [...art.map((l, i) => (i < 3 ? bold(l) : l)), ...(art.length ? [''] : []), ...out].join('\n');
}

/** The prominent READY / WORKING / PAUSED line and the DUE line (F74.7). Never throws on missing parts. */
export function renderQueue(q: QueueView | undefined, due: Due[] | undefined, lvl: (lv: Level, text: string) => string = byLevel, _th?: Thresholds): string[] {
  const out: string[] = [];
  const head = bold('LOCAL QUEUE');
  if (q) {
    switch (q.kind) {
      case 'ready': out.push(`${head}  ${green('READY')} — session active, Ollama up, ${q.queued} job${q.queued === 1 ? '' : 's'} queued, worker not running ${dim(`→ ${START_COMMAND}`)}`); break;
      case 'working': out.push(`${head}  ${yellow('WORKING')} — ${bold(q.job)}${q.attempt ? ` attempt ${q.attempt}/${q.maxAttempts}` : ''} · ${q.index}/${q.total} · ${Math.max(0, q.queued - 1)} remaining`); break;
      case 'paused-idle': out.push(`${head}  ${dim(`PAUSED — no active session (${q.queued} queued; resumes when a prompt is submitted)`)}`); break;
      case 'paused-ollama-down': out.push(`${head}  ${lvl('bad', `PAUSED — Ollama down (${q.queued} queued)`)}`); break;
      case 'paused-manual': out.push(`${head}  ${lvl('warn', `PAUSED — manually (PAUSE file; npx tsx scripts/agent/queue.ts resume) · ${q.queued} queued`)}`); break;
      case 'paused-resources': out.push(`${head}  ${lvl('warn', `PAUSED — GPU busy/hot/full: ${q.reason ?? 'over a limit'} · ${q.queued} queued`)}`); break;
      case 'empty': out.push(`${head}  ${dim('EMPTY — nothing queued')}`); break;
    }
  }
  if (due && due.length) {
    const rank = (d: Due) => (d.due ? -(d.overdueMs ?? Infinity) : (d.dueInMs ?? 0));
    const shown = due.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 8);
    out.push(`  due: ${shown.map((d) => (d.due ? lvl(d.level, dueLabel(d)) : dim(dueLabel(d)))).join(', ')}${due.length > shown.length ? dim(` +${due.length - shown.length} more`) : ''}`);
  }
  return out;
}

export function renderJobs(
  j: JobsView,
  now = new Date(),
  link = (name: string) => hyperlink(name, jobLink(name), color),
  th: Thresholds = loadThresholds(),
  lvl: (lv: Level, text: string) => string = byLevel,
): string[] {
  const out = [`${bold('JOBS')} ${dim('scripts/agent/job-watch.ts · circuit breaker: the same failure repeated refuses the next run')}`];
  for (const c of j.circuits) out.push(`  ${lvl('bad', '⛔ CIRCUIT OPEN')} ${bold(link(c.name))} — ${c.count} identical failures: ${c.signature} ${dim('(--reset to clear)')}`);
  if (j.running.length === 0) out.push(`  ${dim('nothing running')}`);
  for (const r of j.running) {
    const elapsed = now.getTime() - new Date(r.started).getTime();
    const prev = j.medians?.[r.name];
    const open = j.circuits.some((c) => c.name === r.name);
    out.push(`  ${yellow('▶')} ${bold(link(r.name))}  ${lvl(elapsedLevel(elapsed, prev, th.jobElapsedRatio), secs(elapsed))}${prev ? dim(` (median ${secs(prev)})`) : ''} · ${lvl(attemptLevel(r.attempt, r.maxAttempts, open), `attempt ${r.attempt}/${r.maxAttempts}`)} · pid ${r.pid}`);
  }
  if (j.failuresLastHour !== undefined) out.push(`  failures in the last hour: ${lvl(classify(j.failuresLastHour, th.failuresLastHour), String(j.failuresLastHour))}`);
  out.push(`  ${dim('queued: not shown (runner.ts has no side-effect-free queue reader)')}`);
  if (j.finished.length === 0) out.push(`  ${dim('no finished runs recorded')}`);
  for (const f of j.finished.slice().reverse()) {
    const mark = f.status === 'passed' ? green('✓') : f.status === 'refused' ? yellow('⊘') : red('✗');
    out.push(`  ${mark} ${bold(f.name ? link(f.name) : '?')} ${f.status} ${dim(ago(f.startedAt, now))} — ${(f.headline ?? '').slice(0, 90)}`);
  }
  return out;
}

/** One line for a status bar. Never more than ~60 characters, never an error. */
export function statusline(s: Snapshot, now = new Date()): string {
  const j = s.jobs;
  const seg = j && (j.running.length || j.circuits.length) ? ` · jobs: ${[j.running.length ? `${j.running.length} running` : '', j.circuits.length ? `${j.circuits.length} circuit open` : ''].filter(Boolean).join(', ')}` : '';
  const base = statuslineBase(s, now) + seg;
  // Queue segment first and short: `local: ready 12 · idle · last 4m ago`. Empty adds nothing.
  return s.queue && s.queue.kind !== 'empty' && s.ollama.up ? `local: ${queueSegment(s.queue)} · ${base.replace(/^local: /, '')}` : base;
}

function statuslineBase(s: Snapshot, now: Date): string {
  if (!s.ollama.up) return 'local: ollama down';
  const active = s.runs.find((r) => !r.finished);
  if (active) return `local: ${active.task} ${active.done}/${active.total}${active.disagreements ? ` (${active.disagreements}≠)` : ''}`;
  const loaded = s.ollama.loaded.map((m) => m.name.split(':')[0]).join('+');
  const last = s.requests?.[s.requests.length - 1];
  const since = last ? ago(last.at, now) : s.requests === null ? '?' : 'none today';
  return `local: ${loaded || 'idle'} · last ${since}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--refresh-cache')) {
    writeRequestCache();
    return;
  }
  if (argv.includes('--statusline')) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const runs = foldRuns(readEvents()).filter((r) => !r.finished || new Date(r.startedAt) >= today);
    // Jobs here are two small JSON reads (current.json, circuits.json) — never the TTL.
    const jobs: JobsView = { running: readCurrent(), finished: [], circuits: Object.entries(readCircuitCache()).map(([name, c]) => ({ name, ...c })) };
    const ollama = await ollamaState();
    process.stdout.write(statusline({ ollama, gpus: [], requests: cachedRequests(), runs, jobs, queue: withAttempt(readQueueView(ollama.up)) }));
    return;
  }
  const detail = argv.includes('--detail');
  const thresholds = loadThresholds();
  // Art only on a TTY. The swim cycle advances only when colour/animation is allowed (not NO_COLOR).
  const width = process.stdout.isTTY ? process.stdout.columns : undefined;
  if (argv.includes('--once') || !process.stdout.isTTY) {
    console.log(render(await snapshot(), new Date(), { detail, thresholds, width }));
    return;
  }
  const draw = async () => {
    const frame = process.env.NO_COLOR ? 0 : swimFrame++ % TURTLE_FRAMES;
    process.stdout.write(`\x1b[2J\x1b[H${render(await snapshot(), new Date(), { detail, thresholds, width: process.stdout.columns, frame })}\n`);
  };
  await draw();
  setInterval(() => void draw(), 2000);
}

if (process.argv[1] && process.argv[1].endsWith('watch.ts')) void main();
