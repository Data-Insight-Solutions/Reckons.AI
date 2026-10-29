/**
 * Settings → This Device: what the agent watch page puts FIRST (F245). Pure, so it is tested.
 *
 * The terminal window (scripts/agent/watch.ts) prints everything in one column, and once it is
 * taller than the terminal the important lines scroll away. The page instead pins a short headline
 * row: the queue state, Ollama, what is running, open circuits, failures, the GPUs and the last
 * request, each with the same ok / warn / bad level the terminal colours by. The long lists (panel
 * answers, finished jobs, due schedules) follow underneath.
 *
 * The shapes below mirror WebSnapshot in scripts/agent/watch.ts by hand: that module reads the
 * disk, so the app cannot import it. A field the watcher stops sending reads as absent, not a crash.
 */

export type Level = 'ok' | 'warn' | 'bad';
export type Band = { yellow: number; red: number };

/** Same rule as classify() in scripts/agent/watch-render.ts. */
export function classify(value: number | undefined, band: Band | undefined): Level {
  if (value === undefined || Number.isNaN(value) || !band) return 'ok';
  return value >= band.red ? 'bad' : value >= band.yellow ? 'warn' : 'ok';
}

export const worst = (levels: Level[]): Level => (levels.includes('bad') ? 'bad' : levels.includes('warn') ? 'warn' : 'ok');

export type QueueView =
  | ({ kind: 'ready' | 'paused-idle' | 'paused-ollama-down' | 'paused-manual'; queued: number }
    | { kind: 'working'; job: string; attempt?: number; maxAttempts?: number; index: number; total: number; queued: number }
    | { kind: 'paused-resources'; queued: number; reason?: string }
    | { kind: 'empty' }) & { held?: string[] };

export type Vote = { model: string; item: string; value?: string; reason?: string; error?: string };
export type RunView = {
  run: string; task: string; models: string[]; startedAt: string; total: number; done: number; errors: number;
  disagreements: number; finished: boolean; abandoned?: boolean; failed?: string; counts?: Record<string, number>;
  ms?: number; resultPath?: string; recent: Vote[];
};
export type CurrentJob = { name: string; pid: number; started: string; attempt: number; maxAttempts: number };
export type FinishedJob = { name?: string; status: string; exitCode: number; startedAt: string; endedAt?: string; headline?: string; signature?: string };
export type Due = { job: { name: string; label?: string; every?: string }; due: boolean; overdueMs?: number; dueInMs?: number; neverRun: boolean; level: Level };

export type WebSnapshot = {
  at: string;
  ollamaUrl: string;
  ollama: { up: boolean; version?: string; loaded: { name: string; vramBytes: number; contextLength?: number; expiresAt?: string }[] };
  gpus: { index: number; name: string; util: number; usedMiB: number; totalMiB: number }[];
  requests: null | {
    today: number; lastHour: number; busySeconds: number; p50Seconds?: number; idle: boolean; byPath: [string, number][];
    last?: { at: string; method: string; path: string; status: number; seconds: number };
  };
  runs: RunView[];
  jobs?: { running: CurrentJob[]; finished: FinishedJob[]; circuits: { name: string; count: number; signature: string }[]; medians?: Record<string, number>; failuresLastHour?: number };
  queue?: QueueView;
  due?: Due[];
  thresholds?: Partial<Record<'gpuUtil' | 'vramPct' | 'latencySec' | 'jobElapsedRatio' | 'failuresLastHour', Band>>;
};

/** What GET /__reckons/device/agent-watch returns. */
export type WatchStatus = {
  running: boolean;
  pid?: number;
  worker: boolean;
  startedAt?: string;
  snapshot: WebSnapshot | null;
  snapshotAt?: string;
  exit?: { code: number | null; signal: string | null; at: string };
  stderr: string[];
  command: string;
};

export type Headline = { key: string; label: string; value: string; detail?: string; level: Level };

export const ago = (iso: string | undefined, now: Date): string => {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86_400 ? `${(s / 3600).toFixed(1)}h ago` : `${Math.round(s / 86_400)}d ago`;
};

export const duration = (ms: number): string => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : ms < 5_400_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 3_600_000).toFixed(1)}h`);

function queueHeadline(q: QueueView | undefined): Headline {
  if (!q) return { key: 'queue', label: 'queue', value: 'unknown', level: 'ok' };
  const n = 'queued' in q ? q.queued : 0;
  switch (q.kind) {
    case 'working': return { key: 'queue', label: 'queue', value: 'working', detail: `${q.job}${q.attempt ? ` · attempt ${q.attempt}/${q.maxAttempts}` : ''} · ${Math.max(0, q.queued - 1)} after it`, level: q.attempt && q.maxAttempts && q.attempt >= q.maxAttempts ? 'warn' : 'ok' };
    case 'ready': return { key: 'queue', label: 'queue', value: 'ready', detail: `${n} queued, no worker running`, level: 'ok' };
    case 'paused-idle': return { key: 'queue', label: 'queue', value: 'paused', detail: `no active session · ${n} queued`, level: 'ok' };
    case 'paused-ollama-down': return { key: 'queue', label: 'queue', value: 'paused', detail: `Ollama down · ${n} queued`, level: 'bad' };
    case 'paused-manual': return { key: 'queue', label: 'queue', value: 'paused', detail: `by hand (PAUSE file) · ${n} queued`, level: 'warn' };
    case 'paused-resources': return { key: 'queue', label: 'queue', value: 'paused', detail: `${q.reason ?? 'GPU over a limit'} · ${n} queued`, level: 'warn' };
    case 'empty': return { key: 'queue', label: 'queue', value: 'empty', detail: q.held?.length ? `${q.held.length} held` : 'nothing queued', level: q.held?.length ? 'warn' : 'ok' };
  }
}

/**
 * The pinned row, in reading order. Failures are named, never only counted: an open circuit shows
 * the job's name. Every entry is present even when quiet, so the row does not jump about.
 */
export function headline(s: WebSnapshot, now = new Date(s.at)): Headline[] {
  const th = s.thresholds ?? {};
  const out: Headline[] = [queueHeadline(s.queue)];

  out.push(s.ollama.up
    ? { key: 'ollama', label: 'ollama', value: 'up', detail: s.ollama.loaded.length ? s.ollama.loaded.map((m) => m.name).join(', ') : 'no model loaded', level: 'ok' }
    : { key: 'ollama', label: 'ollama', value: 'down', detail: `nothing answers at ${s.ollamaUrl}`, level: 'bad' });

  const job = s.jobs?.running[0];
  const panel = s.runs.find((r) => !r.finished);
  if (job) {
    const elapsed = now.getTime() - new Date(job.started).getTime();
    const med = s.jobs?.medians?.[job.name];
    out.push({ key: 'running', label: 'running', value: job.name, detail: `${duration(elapsed)}${med ? ` (median ${duration(med)})` : ''} · attempt ${job.attempt}/${job.maxAttempts}${(s.jobs?.running.length ?? 0) > 1 ? ` · +${s.jobs!.running.length - 1} more` : ''}`, level: med ? classify(elapsed / med, th.jobElapsedRatio) : 'ok' });
  } else if (panel) {
    out.push({ key: 'running', label: 'running', value: panel.task, detail: `panel ${panel.done}/${panel.total} votes${panel.disagreements ? ` · ${panel.disagreements} disagreeing` : ''}`, level: panel.errors ? 'warn' : 'ok' });
  } else {
    out.push({ key: 'running', label: 'running', value: 'nothing', level: 'ok' });
  }

  const circuits = s.jobs?.circuits ?? [];
  out.push({ key: 'circuits', label: 'circuits', value: circuits.length ? `${circuits.length} open` : 'none open', detail: circuits.map((c) => c.name).join(', ') || undefined, level: circuits.length ? 'bad' : 'ok' });

  const fails = s.jobs?.failuresLastHour;
  out.push({ key: 'failures', label: 'failures 1h', value: fails === undefined ? '?' : String(fails), level: classify(fails, th.failuresLastHour) });

  if (s.gpus.length) {
    const util = Math.max(...s.gpus.map((g) => g.util));
    const vram = Math.max(...s.gpus.map((g) => (g.usedMiB / g.totalMiB) * 100));
    out.push({ key: 'gpu', label: 'gpu', value: `${util}%`, detail: `VRAM ${Math.round(vram)}% (busiest of ${s.gpus.length})`, level: worst([classify(util, th.gpuUtil), classify(vram, th.vramPct)]) });
  }

  const r = s.requests;
  if (r === null) out.push({ key: 'requests', label: 'last request', value: 'unknown', detail: 'Ollama server log not readable here', level: 'ok' });
  else if (!r.last) out.push({ key: 'requests', label: 'last request', value: 'none today', detail: 'no local model has been asked anything', level: 'warn' });
  else out.push({ key: 'requests', label: 'last request', value: ago(r.last.at, now), detail: `${r.last.path} ${r.last.seconds.toFixed(1)}s · ${r.today} today`, level: r.idle ? 'warn' : worst([classify(r.last.seconds, th.latencySec), r.last.status === 200 ? 'ok' : 'bad']) });

  return out;
}

/** Due schedules, overdue first then soonest, like the terminal's DUE line. */
export function sortDue(due: Due[] | undefined): Due[] {
  const rank = (d: Due) => (d.due ? -(d.overdueMs ?? Infinity) : (d.dueInMs ?? 0));
  return (due ?? []).slice().sort((a, b) => rank(a) - rank(b));
}

export function dueText(d: Due): string {
  if (d.neverRun) return 'never run';
  if (d.due) return `overdue ${duration(d.overdueMs ?? 0)}`;
  return `in ${duration(d.dueInMs ?? 0)}`;
}

/** Why the watcher is not giving snapshots, in words; undefined when it is. */
export function watcherProblem(w: WatchStatus): string | undefined {
  if (w.running && w.snapshot) return undefined;
  if (w.running) return 'starting — waiting for the first snapshot (reading the Ollama log takes a few seconds)';
  if (w.exit && w.exit.signal !== 'SIGTERM') return `stopped by itself (${w.exit.signal ?? `exit ${w.exit.code}`})${w.stderr.length ? ` — ${w.stderr[w.stderr.length - 1]}` : ''}`;
  return undefined;
}
