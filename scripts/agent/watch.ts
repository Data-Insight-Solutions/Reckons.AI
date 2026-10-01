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
};

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

export async function snapshot(): Promise<Snapshot> {
  const [ollama] = await Promise.all([ollamaState()]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const runs = foldRuns(readEvents()).filter((r) => !r.finished || new Date(r.startedAt) >= today);
  return { ollama, gpus: gpus(), requests: serverRequests(), runs };
}

const color = !process.env.NO_COLOR && process.stdout.isTTY;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint('2');
const bold = paint('1');
const green = paint('32');
const yellow = paint('33');
const red = paint('31');

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const secs = (ms: number) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`);

function until(iso: string | undefined, now: Date): string {
  if (!iso) return '';
  const s = Math.round((new Date(iso).getTime() - now.getTime()) / 1000);
  return s <= 0 ? 'unloading' : s < 90 ? `unloads in ${s}s` : `unloads in ${Math.round(s / 60)}m`;
}

export function render(s: Snapshot, now = new Date(), opts: { detail?: boolean } = {}): string {
  const out: string[] = [];
  out.push(`${bold('LOCAL MODELS')}  ${dim(now.toLocaleTimeString())}  ${dim('· npm run agent:watch · Ctrl-C quits')}`);
  out.push('');

  if (!s.ollama.up) out.push(`${bold('OLLAMA')}  ${red(`DOWN — nothing answers at ${OLLAMA}`)}`);
  else {
    out.push(`${bold('OLLAMA')}  v${s.ollama.version ?? '?'} at ${OLLAMA.replace(/^https?:\/\//, '')} · ${green('up')}`);
    if (s.ollama.loaded.length === 0) out.push(`  ${dim('no model loaded')}`);
    for (const m of s.ollama.loaded) {
      out.push(`  loaded ${bold(m.name)}  ${gb(m.vramBytes)} VRAM${m.contextLength ? ` · ctx ${m.contextLength}` : ''} · ${dim(until(m.expiresAt, now))}`);
    }
  }

  if (s.gpus.length) {
    out.push(`${bold('GPU')}     ${s.gpus.map((g) => `${g.index}: ${g.name} ${g.util > 5 ? yellow(`${g.util}%`) : `${g.util}%`} ${(g.usedMiB / 1024).toFixed(1)}/${(g.totalMiB / 1024).toFixed(1)} GB`).join(' · ')}`);
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
    out.push(`  today ${s.requests.length} · last hour ${lastHour.length} · ${secs(busy * 1000)} of model time today`);
    const idleMs = now.getTime() - last.at.getTime();
    const lastLine = `last ${ago(last.at, now)}: ${last.method} ${last.path} ${last.seconds.toFixed(1)}s${last.status === 200 ? '' : red(` ${last.status}`)}`;
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
  return out.join('\n');
}

/** One line for a status bar. Never more than ~60 characters, never an error. */
export function statusline(s: Snapshot, now = new Date()): string {
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
    process.stdout.write(statusline({ ollama: await ollamaState(), gpus: [], requests: cachedRequests(), runs }));
    return;
  }
  const detail = argv.includes('--detail');
  if (argv.includes('--once') || !process.stdout.isTTY) {
    console.log(render(await snapshot(), new Date(), { detail }));
    return;
  }
  const draw = async () => process.stdout.write(`\x1b[2J\x1b[H${render(await snapshot(), new Date(), { detail })}\n`);
  await draw();
  setInterval(() => void draw(), 2000);
}

if (process.argv[1] && process.argv[1].endsWith('watch.ts')) void main();
