#!/usr/bin/env npx tsx
/**
 * QUEUE TO SPACE — write the local job queue as a Reckons.AI space (a graph the app renders).
 *
 * Matt, 2026-11-03: "can we visualize the job plan for when we are claude token-less?" When the
 * cloud subscription is exhausted the local deputy works the session queue blind; this makes that
 * plan visible. It reads the queue (queued), the done log (the last 48 h of finished), and
 * current.json (what is running) from the queue directory, and writes them as an ANNOTATED .ttl
 * the app imports — one node per job (urn:kbase:concept/job-<id>), typed as the Job entity type,
 * with status, priority, cwd, branch, head, log, started, finished, outcome-reason, and
 * job-after edges. The Job type is declared right there in the same file so the node gets a shape
 * and a colour without touching the app's built-in list.
 *
 * TIER: script. Zero tokens, zero GPU — a rule over three small files. It runs while a session is
 * active (the session-worker harness), on a 10-minute cadence, for exactly the "token-less" window.
 *
 * FORMAT: the app's annotated export (rdf:Statement reification), because the importer
 * (src/lib/rdf/import-ttl.ts) drops plain triples from a file that also carries reification —
 * every fact here is a reification block with status "confirmed", confidence 1, derived from the
 * source urn:kbase:source/local-job-queue. Deterministic: the only variable line is `# generated`;
 * statement ids are the sha1 of (subject, predicate, object), so two runs over the same queue are
 * byte-identical apart from that line.
 *
 * Usage:
 *   npx tsx scripts/agent/queue-to-space.ts [--dir=<queue dir>] [--out=<path>]
 * Defaults: --dir $XDG_STATE_HOME|~/.local/state/reckons/jobs
 *           --out $XDG_DATA_HOME|~/.local/share/reckons/private-workspace/kbs/job-plan/job-plan.ttl
 *
 * WEAKNESS, said out loud: a RUNNING job (current.json) carries only a name and pid — no queue id —
 * so its node id is the job's queue id when the name still resolves to a queued entry (it does,
 * because the worker removes a job from queue.jsonl only once it finishes), else the slug of its
 * name. A queued job whose name collides with another's is keyed by name, not cwd.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pidAlive, slug } from './job-state.js';

// ── vocabulary ─────────────────────────────────────────────────────────────
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD_DT = 'http://www.w3.org/2001/XMLSchema#dateTime';
const P = 'urn:kbase:predicate/';
const JOB_TYPE = 'urn:kbase:type/Job';
const ENTITY_TYPE = 'urn:kbase:type/EntityType';
const SOURCE_IRI = 'urn:kbase:source/local-job-queue';
const SOURCE_TITLE = 'Local job queue';
/** Fixed per-KB stable id: one for this one synthetic space, so KB Leap and imports can name it. */
const KB_STABLE_ID = 'b1b1b1b1-2c2c-4d3d-8e4e-5f6f708192a3';
/** A schema declaration has no real "created at"; a fixed value keeps the file deterministic. */
const SCHEMA_CREATED = '1970-01-01T00:00:00.000Z';

/** The statuses the app's review vocabulary will understand, mapped from the queue's own words. */
export type JobStatus = 'queued' | 'running' | 'passed' | 'failed' | 'no-commit' | 'blocked' | 'dropped';

export type JobRecord = {
  /** The id used in the node IRI (urn:kbase:concept/job-<key>). */
  key: string;
  name: string;
  status: JobStatus;
  cwd: string;
  /** When enqueued (ISO). Present for queued/done; the "created" timestamp of the node's facts. */
  addedAt?: string;
  started?: string;
  finished?: string;
  priority?: number;
  branch?: string;
  head?: string;
  log?: string;
  outcomeReason?: string;
  /** Names or ids of jobs this one runs after (an `after` field in the queue file). */
  after?: string[];
};

// ── pure core ──────────────────────────────────────────────────────────────

const PREFIXES: [string, string][] = [
  ['kb', 'urn:kbase:concept/'],
  ['src', 'urn:kbase:source/'],
  ['pred', 'urn:kbase:predicate/'],
  ['meta', 'urn:kbase:meta/'],
  ['rdf', 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'],
  ['rdfs', 'http://www.w3.org/2000/01/rdf-schema#'],
  ['owl', 'http://www.w3.org/2002/07/owl#'],
  ['xsd', 'http://www.w3.org/2001/XMLSchema#'],
  ['prov', 'http://www.w3.org/ns/prov#'],
  ['dc', 'http://purl.org/dc/terms/'],
];
const PREFIX_MAP = Object.fromEntries(PREFIXES) as Record<string, string>;

/** Shorten an IRI with the app's default prefixes; otherwise a full <iri>. Mirrors serialize.ts. */
function shorten(iri: string): string {
  for (const [p, ns] of PREFIXES) {
    if (iri.startsWith(ns)) {
      const local = iri.slice(ns.length);
      if (/^[A-Za-z_][\w\-.]*$/.test(local)) return `${p}:${local}`;
    }
  }
  return `<${iri}>`;
}
function lit(value: string, dt?: string): string {
  const v = JSON.stringify(value);
  return dt ? `${v}^^${shorten(dt)}` : v;
}

/** A reified fact. `created` is the deterministic dc:created for its block. */
type Fact = { s: string; p: string; o: string; dt?: string; created: string };

/** Deterministic statement id: sha1 of the fact, formatted as a UUID (8-4-4-4-12). */
function factId(f: Fact): string {
  const h = createHash('sha1').update(`${f.s}\u0000${f.p}\u0000${f.o}\u0000${f.dt ?? ''}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Resolve an `after` value (a job id or name) to the target node's key, or undefined. */
type Resolver = (value: string) => string | undefined;

function factsFor(r: JobRecord, resolve: Resolver): Fact[] {
  const iri = `urn:kbase:concept/job-${r.key}`;
  const created = r.started ?? r.finished ?? r.addedAt ?? SCHEMA_CREATED;
  const F = (p: string, o: string, dt?: string): Fact => ({ s: iri, p, o, ...(dt ? { dt } : {}), created });
  const out: Fact[] = [
    F(RDF_TYPE, JOB_TYPE),
    F(RDFS_LABEL, r.name),
    F(`${P}status`, r.status),
  ];
  if (r.priority !== undefined) out.push(F(`${P}priority`, String(r.priority)));
  out.push(F(`${P}cwd`, r.cwd));
  if (r.branch) out.push(F(`${P}branch`, r.branch));
  if (r.head) out.push(F(`${P}head`, r.head));
  if (r.log) out.push(F(`${P}log`, r.log));
  if (r.started) out.push(F(`${P}started`, r.started, XSD_DT));
  if (r.finished) out.push(F(`${P}finished`, r.finished, XSD_DT));
  if (r.outcomeReason) out.push(F(`${P}outcome-reason`, r.outcomeReason));
  for (const value of [...(r.after ?? [])].sort()) {
    const key = resolve(value);
    if (key) out.push(F(`${P}job-after`, `urn:kbase:concept/job-${key}`));
    // An unresolvable `after` target is dropped, not invented — a dangling edge would render as a
    // node that is nothing. The caller can log it if it wants.
  }
  return out;
}

/**
 * Render the job-plan space as an annotated .ttl the app imports. Pure: given the same records and
 * the same now, the same bytes — except the `# generated` line, which is the only variable.
 */
export function buildSpaceText(records: JobRecord[], nowMs: number): string {
  // Resolve `after` targets against the jobs actually present.
  const byKey = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const r of records) {
    byKey.set(r.key, r.key);
    byName.set(r.name, r.key);
    byName.set(slug(r.name), r.key);
  }
  const resolve: Resolver = (v) => byKey.get(v) ?? byName.get(v) ?? byName.get(slug(v));

  // The Job entity type, declared in this file so the node gets a shape and colour without
  // touching the app's built-in type list. Fixed facts — no per-job timestamp, so a fixed created.
  const t = (p: string, o: string): Fact => ({ s: JOB_TYPE, p, o, created: SCHEMA_CREATED });
  const typeFacts: Fact[] = [
    t(RDF_TYPE, ENTITY_TYPE),
    t(RDFS_LABEL, 'Job'),
    t(`${P}icon`, 'box'),
    t(`${P}color`, '#5b2a86'),
  ];

  const ordered = [...records].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
  const facts: Fact[] = [...typeFacts];
  for (const r of ordered) facts.push(...factsFor(r, resolve));

  const lines: string[] = [];
  lines.push(`# generated ${new Date(nowMs).toISOString()}`);
  lines.push(`# ${facts.length} statements — full annotated export`);
  lines.push('');
  for (const [p, ns] of PREFIXES) lines.push(`@prefix ${p}: <${ns}> .`);
  lines.push('');

  lines.push('# ---- kb identity ----');
  lines.push(`<urn:reckons:kb> <urn:reckons:meta/kbStableId> "${KB_STABLE_ID}" .`);
  lines.push('');

  lines.push('# ---- sources ----');
  lines.push(`src:local-job-queue`);
  lines.push(`    rdf:type meta:Source ;`);
  lines.push(`    dc:title ${JSON.stringify(SOURCE_TITLE)} ;`);
  lines.push(`    dc:created "${SCHEMA_CREATED}"^^xsd:dateTime .`);
  lines.push('');

  lines.push('# ---- statement metadata (all statuses) ----');
  for (const f of facts) {
    lines.push(`<urn:kbase:stmt/${factId(f)}>`);
    lines.push(`    rdf:type rdf:Statement ;`);
    lines.push(`    rdf:subject ${shorten(f.s)} ;`);
    lines.push(`    rdf:predicate ${shorten(f.p)} ;`);
    lines.push(`    rdf:object ${lit(f.o, f.dt)} ;`);
    lines.push(`    meta:status "confirmed" ;`);
    lines.push(`    meta:confidence "1"^^xsd:decimal ;`);
    lines.push(`    prov:wasDerivedFrom src:local-job-queue ;`);
    lines.push(`    dc:created "${f.created}"^^xsd:dateTime .`);
    lines.push('');
  }

  return lines.join('\n');
}

// ── IO layer (thin; injectable for the test) ──────────────────────────────

export type GitFn = (cwd: string, args: string[]) => string;
const realGit: GitFn = (cwd, args) => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The newest `<slug(name)>-*.log` in the queue dir by mtime, or undefined. */
function newestLog(dir: string, name: string, stat: (p: string) => { mtimeMs: number } = (p) => statSync(p)): string | undefined {
  const base = escapeRe(slug(name));
  let best: { p: string; m: number } | undefined;
  try {
    for (const f of readdirSync(dir)) {
      if (!new RegExp(`^${base}-.*\\.log$`).test(f)) continue;
      const p = path.join(dir, f);
      const m = stat(p).mtimeMs;
      if (!best || m > best.m) best = { p, m };
    }
  } catch { return undefined; }
  return best?.p;
}

function mapOutcome(o: unknown): JobStatus {
  switch (o) {
    case 'passed': return 'passed';
    case 'failed': return 'failed';
    case 'dropped': return 'dropped';
    case 'refused': return 'blocked';
    case 'no-commit': return 'no-commit';
    default: return 'failed';
  }
}
function normAfter(a: unknown): string[] | undefined {
  if (a === undefined) return undefined;
  if (typeof a === 'string') return [a];
  if (Array.isArray(a)) { const v = a.filter((x) => typeof x === 'string'); return v.length ? v : undefined; }
  return undefined;
}
function readLines(p: string): string[] {
  try { return readFileSync(p, 'utf8').split('\n'); } catch { return []; }
}
function asJob(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try { return JSON.parse(line) as Record<string, unknown>; } catch { return undefined; }
}
function str(v: unknown): string | undefined { return typeof v === 'string' && v ? v : undefined; }

type BuildOpts = {
  git?: GitFn;
  alive?: (pid: number) => boolean;
  stat?: (p: string) => { mtimeMs: number };
};

/**
 * Read the three queue files in `dir` into JobRecords. Queued jobs are queue.jsonl; running ones
 * are the live pids in current.json (a queued job whose name matches is 'running'); finished ones
 * are queue.done.jsonl within the last 48 h of nowMs. branch/head come from git in the job's cwd
 * (omitted when it is not a repo); log is the newest matching file in the dir.
 */
export function buildRecords(dir: string, nowMs: number, opts: BuildOpts = {}): JobRecord[] {
  const gitFn = opts.git ?? realGit;
  const alive = opts.alive ?? pidAlive;
  const statFn = opts.stat ?? ((p: string) => statSync(p));
  const records: JobRecord[] = [];
  const now48 = nowMs - 48 * 3_600_000;

  const decorate = (rec: JobRecord): void => {
    rec.branch = gitFn(rec.cwd, ['branch', '--show-current']) || undefined;
    rec.head = gitFn(rec.cwd, ['rev-parse', '--short', 'HEAD']) || undefined;
    rec.log = newestLog(dir, rec.name, statFn);
  };

  // queued.jsonl: id, name, cwd, addedAt, priority, after
  const queued = new Map<string, Record<string, unknown>>();
  for (const line of readLines(path.join(dir, 'queue.jsonl'))) {
    const j = asJob(line);
    if (!j || !str(j.id) || !str(j.name) || !str(j.cwd)) continue;
    queued.set(str(j.name)!, j);
  }

  // current.json: the running jobs (live pids only)
  let current: unknown = [];
  try { current = JSON.parse(readFileSync(path.join(dir, 'current.json'), 'utf8')); } catch { current = []; }
  const running: Record<string, unknown>[] = Array.isArray(current)
    ? current.filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).pid === 'number' && alive((c as Record<string, unknown>).pid as number))
    : [];
  const runningName = new Set(running.map((c) => str(c.name)).filter((n): n is string => !!n));

  for (const [name, j] of queued) {
    if (!name) continue;
    const isRunning = runningName.has(name);
    const cur = isRunning ? running.find((c) => str(c.name) === name) : undefined;
    const rec: JobRecord = {
      key: str(j.id)!,
      name,
      status: isRunning ? 'running' : 'queued',
      cwd: str(j.cwd)!,
      addedAt: str(j.addedAt),
      ...(isRunning && cur ? { started: str(cur.started) } : {}),
      ...(typeof j.priority === 'number' ? { priority: j.priority } : {}),
      ...(normAfter(j.after) ? { after: normAfter(j.after) } : {}),
    };
    decorate(rec);
    records.push(rec);
  }

  // A running job whose queue entry is already gone: key it by its name (the WEAKNESS above).
  for (const c of running) {
    const name = str(c.name);
    if (!name || queued.has(name)) continue;
    const rec: JobRecord = {
      key: slug(name),
      name,
      status: 'running',
      cwd: str(c.cwd) ?? '.',
      started: str(c.started),
    };
    decorate(rec);
    records.push(rec);
  }

  // queue.done.jsonl: finished in the last 48 h
  for (const line of readLines(path.join(dir, 'queue.done.jsonl'))) {
    const j = asJob(line);
    if (!j || !str(j.id) || !str(j.name)) continue;
    const finished = str(j.finishedAt);
    if (!finished) continue;
    const t = Date.parse(finished);
    if (!Number.isFinite(t) || t < now48) continue;
    const rec: JobRecord = {
      key: str(j.id)!,
      name: str(j.name)!,
      status: mapOutcome(j.outcome),
      cwd: str(j.cwd) ?? '.',
      addedAt: str(j.addedAt),
      finished,
      ...(typeof j.priority === 'number' ? { priority: j.priority } : {}),
      ...(normAfter(j.after) ? { after: normAfter(j.after) } : {}),
      ...(str(j.outcome) ? { outcomeReason: str(j.outcome) } : {}),
    };
    decorate(rec);
    records.push(rec);
  }

  return records;
}

// ── writer ─────────────────────────────────────────────────────────────────

const defaultQueueDir = (): string =>
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons', 'jobs');
const defaultOut = (): string =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'reckons', 'private-workspace', 'kbs', 'job-plan', 'job-plan.ttl');

function writeAtomic(p: string, text: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, p);
}

function main(): void {
  const args = process.argv.slice(2);
  // Accept both `--flag=value` and `--flag value` (the done-test and the schedule both
  // write the space form).
  const flag = (k: string): string | undefined => {
    const eq = args.find((a) => a.startsWith(`--${k}=`));
    if (eq) return eq.slice(k.length + 3);
    const i = args.indexOf(`--${k}`);
    if (i >= 0 && i + 1 < args.length) return args[i + 1];
    return undefined;
  };
  const dir = flag('dir') ?? defaultQueueDir();
  const out = flag('out') ?? defaultOut();
  const nowMs = Date.now();
  const records = buildRecords(dir, nowMs);
  writeAtomic(out, buildSpaceText(records, nowMs));
  console.log(`job-plan: ${records.length} job(s) → ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
