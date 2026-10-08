/**
 * LOCAL ACTIVITY — a record of what the local models are doing, so it is visible rather than hidden.
 *
 * Matt, 2026-09-30: "Instead of hidden background tasks I don't see and can't immediately know if
 * they aren't even being used yet like this morning." That morning a whole session had used no
 * local model at all, and nothing on screen could have said so. A local run is a shell command, not
 * a Claude Code agent, so it never appears in Claude Code's agent list; this file is how it appears
 * anywhere.
 *
 * Two sources, because either alone lies by omission:
 *   1. an EVENT LOG the local panel writes as each vote lands — what was asked, what came back, why;
 *   2. the OLLAMA SERVER LOG, which sees every request from every caller (the app, code-review.ts,
 *      another agent) but not what they were for.
 *
 * The event log lives OUTSIDE the repository, under $XDG_STATE_HOME/reckons/local-agents/ (default
 * ~/.local/state/), like the host-check reports: vote reasons quote source lines and prompts, and a
 * working log is not something to commit by accident.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

export function eventLogPath(): string {
  const state = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(state, 'reckons', 'local-agents', 'events.jsonl');
}

export type ActivityEvent =
  | { kind: 'run-start'; run: string; at: string; task: string; models: string[]; items: number; votesPerModel: number; engine: string; cwd: string; pid?: number; host?: string }
  | { kind: 'vote'; run: string; at: string; model: string; item: string; value?: string; reason?: string; error?: string; ms: number }
  | { kind: 'run-end'; run: string; at: string; ms: number; counts: Record<string, number>; resultPath?: string; failed?: string };

const MAX_BYTES = 5_000_000;

/** Append one event. Never throws: a broken log must not break the run it is describing. */
export function logEvent(event: ActivityEvent, path = eventLogPath()): void {
  // Node 22's recursive mkdir never returns under /proc (measured 2026-09-30), so a mistaken
  // XDG_STATE_HOME there would hang the run being logged. Refuse the pseudo-filesystems outright.
  if (/^\/(proc|sys)(\/|$)/.test(path)) return;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (existsSync(path) && statSync(path).size > MAX_BYTES) {
      // Rotate by RENAME, which is atomic: a vote appended by a concurrent job lands in one file or
      // the other. Reading and rewriting in place could drop one written in between (local review,
      // 2026-09-30). One previous file is kept; the dashboard reads only the current one.
      renameSync(path, `${path}.1`);
    }
    appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  } catch {
    /* visibility is best-effort; the run's own result file is the record */
  }
}

export function readEvents(path = eventLogPath()): ActivityEvent[] {
  if (!existsSync(path)) return [];
  const out: ActivityEvent[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as ActivityEvent);
    } catch {
      /* a torn last line from a concurrent append */
    }
  }
  return out;
}

export type RunView = {
  run: string;
  task: string;
  models: string[];
  startedAt: string;
  total: number;
  done: number;
  errors: number;
  /** Items with every vote in whose votes differ, plus items already showing two different values. */
  disagreements: number;
  finished: boolean;
  /** No run-end, and the process is gone (or, for old events without a pid, silent too long). Implies finished. */
  abandoned?: boolean;
  failed?: string;
  counts?: Record<string, number>;
  ms?: number;
  resultPath?: string;
  recent: Extract<ActivityEvent, { kind: 'vote' }>[];
};

/** Fold the log into one view per run, newest last. Pure, so the dashboard's numbers are tested. */
export type Liveness = {
  now?: Date;
  host?: string;
  /** Is this pid alive on this host? Injectable so the fold stays pure. */
  isAlive?: (pid: number) => boolean;
  /** Old events carry no pid: a run silent for longer than this is taken as dead. */
  staleMs?: number;
};

/** process.kill(pid, 0): ESRCH means gone; EPERM means it exists but is not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export const STALE_RUN_MS = 10 * 60_000;

export function foldRuns(events: ActivityEvent[], recentPerRun = 8, liveness: Liveness = {}): RunView[] {
  const { now = new Date(), host = hostname(), isAlive = pidAlive, staleMs = STALE_RUN_MS } = liveness;
  const runs = new Map<string, RunView>();
  const pids = new Map<string, { pid: number; host?: string }>();
  const lastAt = new Map<string, string>();
  const values = new Map<string, Map<string, Set<string>>>();
  for (const e of events) {
    if (e.kind === 'run-start') {
      runs.set(e.run, {
        run: e.run, task: e.task, models: e.models, startedAt: e.at,
        total: e.items * e.models.length * e.votesPerModel, done: 0, errors: 0, disagreements: 0,
        finished: false, recent: [],
      });
      values.set(e.run, new Map());
      lastAt.set(e.run, e.at);
      if (e.pid !== undefined) pids.set(e.run, { pid: e.pid, host: e.host });
      continue;
    }
    const view = runs.get(e.run);
    if (!view) continue;
    lastAt.set(e.run, e.at);
    if (e.kind === 'vote') {
      view.done++;
      if (e.error) view.errors++;
      view.recent.push(e);
      if (view.recent.length > recentPerRun) view.recent.shift();
      if (e.value !== undefined) {
        const byItem = values.get(e.run)!;
        const seen = byItem.get(e.item) ?? new Set<string>();
        seen.add(e.value);
        byItem.set(e.item, seen);
        view.disagreements = [...byItem.values()].filter((s) => s.size > 1).length;
      }
    } else {
      view.finished = true;
      view.failed = e.failed;
      view.counts = e.counts;
      view.ms = e.ms;
      view.resultPath = e.resultPath;
    }
  }
  for (const view of runs.values()) {
    if (view.finished) continue;
    const p = pids.get(view.run);
    const dead = p && (p.host === undefined || p.host === host)
      ? !isAlive(p.pid)
      // Another host's pid cannot be probed, and old events have none: fall back to silence.
      : now.getTime() - new Date(lastAt.get(view.run) ?? view.startedAt).getTime() > staleMs;
    if (dead) {
      view.finished = true;
      view.abandoned = true;
      view.failed = 'abandoned';
    }
  }
  return [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export type OllamaRequest = { at: Date; status: number; seconds: number; method: string; path: string };

const INFERENCE = /\/api\/(chat|generate|embed|embeddings)$|\/v1\/(messages|chat\/completions|completions|embeddings)$/;

/**
 * One `[GIN]` access line from the Ollama server log, e.g.
 *   [GIN] 2026/09/30 - 10:39:58 | 200 |  3.537698806s |       127.0.0.1 | POST     "/v1/chat/completions"
 * Returns null for anything that is not an inference request (health checks, /api/ps, /api/tags).
 */
export function parseGinLine(line: string): OllamaRequest | null {
  const m = line.match(/\[GIN\] (\d{4})\/(\d\d)\/(\d\d) - (\d\d):(\d\d):(\d\d) \| (\d{3}) \|\s+([\d.]+)(µs|ms|s|m)\s*\|[^|]*\|\s*(\w+)\s+"([^"]+)"/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, status, amount, unit, method, path] = m;
  if (!INFERENCE.test(path)) return null;
  const scale = unit === 'µs' ? 1e-6 : unit === 'ms' ? 1e-3 : unit === 'm' ? 60 : 1;
  return {
    at: new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    status: Number(status),
    seconds: Number(amount) * scale,
    method,
    path,
  };
}

export function ago(from: Date | string, now = new Date()): string {
  const s = Math.max(0, Math.round((now.getTime() - new Date(from).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}
