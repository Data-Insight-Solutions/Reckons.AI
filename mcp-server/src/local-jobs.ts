/**
 * LOCAL JOBS over MCP (F267) — list, queue and check the jobs the local worker drains.
 *
 * Matt, 2026-10-27: "The lesson isn't learnt the last 10 times it was recorded. I think we need the
 * local jobs to be a default, and through MCP and well documented."
 *
 * This is NOT a second queue. It reads and writes the files scripts/agent/session-queue.ts owns
 * (queue.jsonl, queue.done.jsonl, worker.json under $XDG_STATE_HOME/reckons/jobs/), and the job
 * definitions in static/reckons-jobs.ttl (the source, F216) and reckons-workspace/schedules.ttl.
 * The jobs graph is read here with N3 because this package cannot import scripts/lib/jobs-graph-read.ts;
 * copying the file in at setup would add a step that can go stale, a second small reader cannot.
 *
 * ENQUEUE IS AN ALLOWLIST. Only a name defined in those two files can be queued, and the command
 * run is the one defined there. An agent can never pass a command string through this tool.
 *
 * WEAKNESS, said out loud: the MCP server is a standalone package and cannot import scripts/agent,
 * so the queue line format and the flock locking are re-implemented here. If session-queue.ts
 * changes its format this file must change with it; local-jobs.test.ts pins the format only as far
 * as this file reads and writes it.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';

export const START_HINT = 'npm run agent:watch';

export type JobCtx = {
  /** Main checkout root (holds static/reckons-jobs.ttl and reckons-workspace/). */
  root: string;
  /** $XDG_STATE_HOME/reckons */
  stateHome: string;
  /** Worker liveness; injectable for tests. */
  workerAlive?: (pid: number) => boolean;
};

export type JobDef = { name: string; source: 'jobs graph' | 'schedule'; tier: string; desc: string; cmd: string };

export function defaultCtx(): JobCtx {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let root = process.env.RECKONS_ROOT ?? '';
  if (!root) {
    try {
      const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: here, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      root = path.dirname(common);
    } catch { root = path.resolve(here, '..', '..'); }
  }
  return { root, stateHome: path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons') };
}

const jobsDir = (c: JobCtx) => path.join(c.stateHome, 'jobs');
const queueFile = (c: JobCtx) => path.join(jobsDir(c), 'queue.jsonl');
const doneFile = (c: JobCtx) => path.join(jobsDir(c), 'queue.done.jsonl');
const workerFile = (c: JobCtx) => path.join(jobsDir(c), 'worker.json');
const pauseFile = (c: JobCtx) => path.join(jobsDir(c), 'PAUSE');
const lockFile = (c: JobCtx) => path.join(jobsDir(c), 'queue.lock');

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'job';

// ── definitions ────────────────────────────────────────────────────────────

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SKOS_DEFINITION = 'http://www.w3.org/2004/02/skos/core#definition';
const HNAV_ORDER = 'urn:reckons:nav/order';
const OFFLINE_JOB = 'urn:kbase:type/OfflineJob';

/** Every runnable job: enabled entries of the jobs graph, then enabled schedules (named sched:<id>). */
export function loadJobDefs(c: JobCtx): JobDef[] {
  const defs: JobDef[] = [];
  try {
    const jobs = new Map<string, Record<string, string>>();
    for (const q of new Parser().parse(readFileSync(path.join(c.root, 'static', 'reckons-jobs.ttl'), 'utf8'))) {
      const p = q.predicate.value;
      const key = p === RDF_TYPE ? 'type' : p === RDFS_LABEL ? 'label' : p === SKOS_DEFINITION ? 'desc' : p === HNAV_ORDER ? 'order' : p.startsWith(KPRED) ? p.slice(KPRED.length) : '';
      if (!key) continue;
      const o = jobs.get(q.subject.value) ?? {};
      o[key] = q.object.value;
      jobs.set(q.subject.value, o);
    }
    const rows = [...jobs.values()].filter((o) => o.type === OFFLINE_JOB && o.label && o.command && o['job-enabled'] !== 'false');
    rows.sort((x, y) => Number(x.order ?? 1e6) - Number(y.order ?? 1e6));
    for (const o of rows) defs.push({ name: o.label, source: 'jobs graph', tier: o['job-tier'] ?? 'agent', desc: o.desc ?? '', cmd: o.command });
  } catch { /* no jobs graph: nothing from it */ }
  try {
    const by = new Map<string, Record<string, string>>();
    for (const q of new Parser().parse(readFileSync(path.join(c.root, 'reckons-workspace', 'schedules.ttl'), 'utf8'))) {
      const p = q.predicate.value;
      const key = p.startsWith(KPRED) ? p.slice(KPRED.length) : p === RDFS_LABEL ? 'label' : '';
      if (!key) continue;
      const o = by.get(q.subject.value) ?? {};
      o[key] = q.object.value;
      by.set(q.subject.value, o);
    }
    for (const [iri, o] of by) {
      if (!o.command || o.enabled === 'false') continue;
      defs.push({ name: `sched:${iri.split('/').pop()}`, source: 'schedule', tier: o.tier ?? 'agent', desc: o.description ?? o.label ?? '', cmd: o.command });
    }
  } catch { /* no schedules file */ }
  return defs;
}

// ── queue files ────────────────────────────────────────────────────────────

type QJob = { id: string; name: string; cwd: string; argv: string[]; addedAt: string; priority?: number; gpu?: boolean };
type DoneRec = QJob & { finishedAt: string; outcome: string; exitCode?: number };

const parseLines = <T>(text: string): T[] => text.split('\n').flatMap((l) => { try { return l.trim() ? [JSON.parse(l) as T] : []; } catch { return []; } });
const readQueue = (c: JobCtx): QJob[] => { try { return parseLines<QJob>(readFileSync(queueFile(c), 'utf8')).filter((j) => typeof j.id === 'string' && typeof j.name === 'string' && Array.isArray(j.argv)); } catch { return []; } };
const readDone = (c: JobCtx): DoneRec[] => { try { return parseLines<DoneRec>(readFileSync(doneFile(c), 'utf8')); } catch { return []; } };

type WorkerRec = { state?: string; pid?: number; job?: string; reason?: string };
function readWorker(c: JobCtx): WorkerRec | undefined {
  try {
    const w = JSON.parse(readFileSync(workerFile(c), 'utf8')) as WorkerRec;
    if (!Number.isInteger(w.pid)) return undefined;
    const alive = c.workerAlive ?? ((pid: number) => {
      try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
      try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('queue-worker'); } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT' || !existsSync('/proc/self'); }
    });
    return alive(w.pid as number) ? w : undefined;
  } catch { return undefined; }
}

/** Same kernel flock the worker takes (state-file.ts), so an enqueue never interleaves with its rewrite. */
function withQueueLock<T>(c: JobCtx, action: () => T): T {
  mkdirSync(jobsDir(c), { recursive: true });
  const fd = openSync(lockFile(c), 'a', 0o600);
  try {
    const r = spawnSync('flock', ['-x', '-w', '10', '3'], { stdio: ['ignore', 'ignore', 'pipe', fd], encoding: 'utf8' });
    if (r.error) throw new Error(`could not start flock: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`could not lock the queue: ${(r.stderr ?? '').trim() || `flock exited ${r.status}`}`);
    const active = `${lockFile(c)}.active`;
    const now = Date.now();
    writeFileSync(active, JSON.stringify({ version: 1, pid: process.pid, acquiredAt: now, expiresAt: now + 60_000 }) + '\n');
    try { return action(); } finally { try { rmSync(active, { force: true }); } catch { /* lease expires */ } }
  } finally { closeSync(fd); }
}

// ── status ─────────────────────────────────────────────────────────────────

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const LOG_TAIL_LINES = 40;

/** Newest log job-watch wrote for this name (`<slug>-<ISO timestamp>.log` in the jobs state dir). */
export function latestLog(c: JobCtx, name: string): string | undefined {
  const re = new RegExp(`^${slug(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z?\\.log$`);
  try {
    const hit = readdirSync(jobsDir(c)).filter((f) => re.test(f)).map((f) => ({ f, t: statSync(path.join(jobsDir(c), f)).mtimeMs })).sort((a, b) => b.t - a.t)[0];
    return hit ? path.join(jobsDir(c), hit.f) : undefined;
  } catch { return undefined; }
}

function tail(file: string): string {
  try { return readFileSync(file, 'utf8').replace(ANSI, '').split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).slice(-LOG_TAIL_LINES).join('\n'); } catch { return ''; }
}

const workerNote = (c: JobCtx): string => {
  const w = readWorker(c);
  if (!w) return `no worker running; start it with ${START_HINT}`;
  if (existsSync(pauseFile(c))) return 'worker running but the queue is PAUSED (npm run agent:queue -- resume)';
  return `worker ${w.state ?? 'running'}${w.reason ? ` (${w.reason})` : ''}`;
};

// ── tools ──────────────────────────────────────────────────────────────────

export function jobList(c: JobCtx): string {
  const defs = loadJobDefs(c);
  const done = readDone(c);
  const queued = new Set(readQueue(c).map((j) => j.name));
  const running = readWorker(c)?.job;
  const lines = [`${defs.length} job(s) defined. Queue one with kb_job_enqueue(name); check it with kb_job_status(name). Worker: ${workerNote(c)}.`, ''];
  for (const d of defs) {
    const last = [...done].reverse().find((r) => r.name === d.name);
    const state = running === d.name ? 'running' : queued.has(d.name) ? 'queued' : 'idle';
    lines.push(`${d.name} [${d.tier}, ${d.source}] ${state} — last run: ${last ? `${last.outcome} at ${last.finishedAt}${last.exitCode !== undefined ? ` (exit ${last.exitCode})` : ''}` : 'never recorded'}`);
    if (d.desc) lines.push(`  ${d.desc.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
  return lines.join('\n');
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

export function jobEnqueue(c: JobCtx, args: { name?: string; args?: string[] }): { ok: boolean; text: string } {
  const def = typeof args.name === 'string' ? loadJobDefs(c).find((d) => d.name === args.name) : undefined;
  if (!def) {
    const names = loadJobDefs(c).map((d) => d.name);
    return { ok: false, text: `Unknown job ${JSON.stringify(args.name)}. Only jobs defined in static/reckons-jobs.ttl or the schedules file can be queued, never a command. Defined: ${names.join(', ') || '(none found)'}` };
  }
  const extra = args.args ?? [];
  if (!Array.isArray(extra) || extra.some((a) => typeof a !== 'string' || a.includes('\0'))) return { ok: false, text: 'args must be an array of strings' };
  const cmd = extra.length ? `${def.cmd} ${extra.map(shq).join(' ')}` : def.cmd;
  const job: QJob = { id: randomUUID().slice(0, 8), name: def.name, cwd: c.root, argv: ['/bin/bash', '-c', cmd], addedAt: new Date().toISOString(), ...(def.tier === 'script' ? { gpu: false } : {}) };
  const r = withQueueLock(c, () => {
    const existing = readQueue(c).find((j) => j.name === job.name && j.cwd === job.cwd);
    if (existing) return { dup: existing };
    const tmp = `${queueFile(c)}.${process.pid}.tmp`;
    const all = [...readQueue(c), job];
    writeFileSync(tmp, all.map((j) => JSON.stringify(j)).join('\n') + '\n');
    renameSync(tmp, queueFile(c));
    return { dup: undefined };
  });
  if (r.dup) return { ok: true, text: `Already queued: ${def.name} (id ${r.dup.id}). Not added twice. ${workerNote(c)}.` };
  const w = readWorker(c);
  const state = w ? `the worker will pick it up (${workerNote(c)})` : `queued — no worker running; start it with ${START_HINT}`;
  return { ok: true, text: `Queued ${def.name} (id ${job.id}); ${state}. Check it with kb_job_status(id="${job.id}").` };
}

export function jobStatus(c: JobCtx, args: { id?: string; name?: string }): string {
  if (!args.id && !args.name) return 'Pass id or name. kb_job_list shows the names.';
  const q = readQueue(c).find((j) => (args.id ? j.id === args.id : j.name === args.name));
  const done = [...readDone(c)].reverse().find((j) => (args.id ? j.id === args.id : j.name === args.name));
  const name = q?.name ?? done?.name ?? args.name;
  if (!name) return `No job with id ${args.id} is queued or recorded as finished.`;
  const w = readWorker(c);
  const logFile = latestLog(c, name);
  const logLine = logFile ? `full log: ${logFile}` : 'full log: none yet';
  let head: string;
  if (w?.job === name && (!args.id || q?.id === args.id || !done)) head = `running — the worker is executing ${name} now`;
  else if (q) head = w ? `queued (id ${q.id}) — ${workerNote(c)}` : `queued (id ${q.id}) — no worker running; start it with ${START_HINT}`;
  else if (done) head = `${done.outcome === 'passed' ? 'done' : done.outcome} (id ${done.id}) at ${done.finishedAt}${done.exitCode !== undefined ? `, exit code ${done.exitCode}` : ''}`;
  else head = `idle — ${name} is not queued and has no recorded run`;
  const t = !q && logFile ? tail(logFile) : '';
  return [`${name}: ${head}`, logLine, ...(t ? [`log tail (last ${LOG_TAIL_LINES} lines max):`, t] : [])].join('\n');
}
