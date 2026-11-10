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
 * DEVICE MODE (F269.1, --device): the same script also writes the FULL per-job record for the private
 * device space: see buildDeviceSpaceText below. It goes to its own file, apart from anything a person
 * edits, mode 0600, and the writer refuses a path inside a Git checkout. The job-plan output above is
 * unchanged (same path, same nodes) so the running 10-minute schedule is not disturbed.
 *
 * WEAKNESS, said out loud: a RUNNING job (current.json) carries only a name and pid — no queue id —
 * so its node id is the job's queue id when the name still resolves to a queued entry (it does,
 * because the worker removes a job from queue.jsonl only once it finishes), else the slug of its
 * name. A queued job whose name collides with another's is keyed by name, not cwd.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'n3';
import { pidAlive, slug } from './job-state.js';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';

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

  return renderSpace(facts, nowMs, { stableId: KB_STABLE_ID, sourceIri: SOURCE_IRI, sourceTitle: SOURCE_TITLE });
}

/** Serialize facts as the app's annotated export: every fact a confirmed, derived reification block. */
function renderSpace(facts: Fact[], nowMs: number, id: { stableId: string; sourceIri: string; sourceTitle: string }): string {
  const srcShort = shorten(id.sourceIri);
  const lines: string[] = [];
  lines.push(`# generated ${new Date(nowMs).toISOString()}`);
  lines.push(`# ${facts.length} statements — full annotated export`);
  lines.push('');
  for (const [p, ns] of PREFIXES) lines.push(`@prefix ${p}: <${ns}> .`);
  lines.push('');

  lines.push('# ---- kb identity ----');
  lines.push(`<urn:reckons:kb> <urn:reckons:meta/kbStableId> "${id.stableId}" .`);
  lines.push('');

  lines.push('# ---- sources ----');
  lines.push(srcShort);
  lines.push(`    rdf:type meta:Source ;`);
  lines.push(`    dc:title ${JSON.stringify(id.sourceTitle)} ;`);
  lines.push(`    dc:created "${SCHEMA_CREATED}"^^xsd:dateTime .`);
  lines.push('');

  lines.push('# ---- statement metadata (all statuses) ----');
  const seen = new Set<string>();
  for (const f of facts) {
    const sid = factId(f);
    if (seen.has(sid)) continue; // one block per distinct fact
    seen.add(sid);
    lines.push(`<urn:kbase:stmt/${sid}>`);
    lines.push(`    rdf:type rdf:Statement ;`);
    lines.push(`    rdf:subject ${shorten(f.s)} ;`);
    lines.push(`    rdf:predicate ${shorten(f.p)} ;`);
    lines.push(`    rdf:object ${lit(f.o, f.dt)} ;`);
    lines.push(`    meta:status "confirmed" ;`);
    lines.push(`    meta:confidence "1"^^xsd:decimal ;`);
    lines.push(`    prov:wasDerivedFrom ${srcShort} ;`);
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


// ── device space: the full per-job record (F269.1) ─────────────────────────

const DEVICE_STABLE_ID = 'b1b1b1b1-2c2c-4d3d-8e4e-5f6f708192a4';
const DEVICE_SOURCE_IRI = 'urn:kbase:source/device-job-records';
const DEVICE_SOURCE_TITLE = 'Local job records (derived by script)';
const DEVICE_JOB_TYPE = 'urn:kbase:type/DeviceJob';
const DEVICE_RUN_TYPE = 'urn:kbase:type/DeviceJobRun';
/** The leap predicate of src/lib/rdf/kb-leap.ts (LEAP_PRED / LEAP_LABEL_PRED); the target is a stable id. */
const LEAP_PRED = 'urn:reckons:leap';
const LEAP_LABEL_PRED = 'urn:reckons:leap/label';
/** Run nodes kept per job; older runs are only a count (F269.1). */
export const RUNS_KEPT = 20;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DeviceJobState = 'running' | 'given-up' | 'held' | 'queued' | 'idle';
export type JobDef = { key: string; name: string; tier?: string; enabled?: boolean; description?: string; schedule?: string };
export type RawRun = {
  id: string; name: string; finishedAt: string; startedAt?: string; outcome: string; exitCode?: number; reason?: string;
  /** From the done record's `result` (what the job wrote to RECKONS_JOB_RESULT, F58.9.20), when it has one:
   *  the output asset's content id and the space it was made for (a stable id leaps; a folder name stays a label). */
  output?: string; forSpace?: string;
};
export type RawQueued = { id: string; name: string; after?: string[]; gpu?: boolean; gpuIndex?: number; addedAt?: string };
export type DeviceInput = {
  defs: JobDef[];
  queued: RawQueued[];
  running: { name: string; started?: string }[];
  /** name -> reason, from worker.json's held list. */
  held: Map<string, string>;
  /** name -> failure signature, from circuits.json (an open circuit = the worker gave up). */
  circuits: Map<string, { count: number; signature: string }>;
  done: RawRun[];
};

/** `sched:x` and `x` are the same job. */
const jobKeyOf = (name: string): string => slug(name.replace(/^sched:/, ''));

/** Defined jobs (static/reckons-jobs.ttl) and schedules (schedules.ttl), by key. Pure over the two texts. */
export function parseDefinitions(jobsTtl: string, schedulesTtl: string): JobDef[] {
  const NS = { type: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', label: RDFS_LABEL, def: 'http://www.w3.org/2004/02/skos/core#definition' };
  const read = (ttl: string): Map<string, Map<string, string>> => {
    const m = new Map<string, Map<string, string>>();
    try {
      for (const q of new Parser().parse(ttl)) {
        const o = m.get(q.subject.value) ?? new Map<string, string>();
        if (!o.has(q.predicate.value)) o.set(q.predicate.value, q.object.value);
        m.set(q.subject.value, o);
      }
    } catch { /* an unparsable file contributes nothing, loudly absent from the output */ }
    return m;
  };
  const defs = new Map<string, JobDef>();
  for (const [, o] of read(jobsTtl)) {
    if (o.get(NS.type) !== 'urn:kbase:type/OfflineJob') continue;
    const name = o.get(NS.label);
    if (!name) continue;
    defs.set(jobKeyOf(name), { key: jobKeyOf(name), name, tier: o.get(`${P}job-tier`), enabled: o.get(`${P}job-enabled`) !== 'false', description: o.get(NS.def) });
  }
  for (const [iri, o] of read(schedulesTtl)) {
    if (o.get(NS.type) !== 'urn:kbase:type/Schedule') continue;
    const id = iri.split(/[/#:]/).pop() ?? iri;
    const key = jobKeyOf(id);
    const prev = defs.get(key);
    const every = o.get(`${P}every`);
    defs.set(key, {
      key, name: prev?.name ?? id, tier: prev?.tier ?? o.get(`${P}tier`), enabled: prev?.enabled ?? o.get(`${P}enabled`) !== 'false',
      description: prev?.description ?? o.get(NS.label), ...(every ? { schedule: every } : {}),
    });
  }
  return [...defs.values()];
}

const cardOf = (q?: { gpu?: boolean; gpuIndex?: number }): string | undefined =>
  !q ? undefined : q.gpu === false ? 'cpu' : typeof q.gpuIndex === 'number' ? `gpu${q.gpuIndex}` : 'any gpu';

/**
 * Render the device space's job records. Pure: the same input gives the same bytes apart from the
 * `# generated` line. Every fact is confirmed and derived from one named source: nothing here is a
 * proposal.
 */
export function buildDeviceSpaceText(input: DeviceInput, nowMs: number): string {
  const defs = new Map(input.defs.map((d) => [d.key, d]));
  const jobIri = (key: string): string => `urn:kbase:concept/device-job-${key}`;
  const runsBy = new Map<string, RawRun[]>();
  for (const r of input.done) {
    const k = jobKeyOf(r.name);
    (runsBy.get(k) ?? runsBy.set(k, []).get(k)!).push(r);
  }
  const queuedBy = new Map(input.queued.map((q) => [jobKeyOf(q.name), q]));
  const runningBy = new Map(input.running.map((r) => [jobKeyOf(r.name), r]));
  const heldBy = new Map([...input.held].map(([n, why]) => [jobKeyOf(n), why]));
  const circBy = new Map([...input.circuits].map(([n, c]) => [jobKeyOf(n), c]));
  const passedKeys = new Set(input.done.filter((r) => r.outcome === 'passed').map((r) => jobKeyOf(r.name)));

  // Which jobs get a node: anything with state or a run. A defined job with nothing to say has none.
  const keys = new Set<string>([...runsBy.keys(), ...queuedBy.keys(), ...runningBy.keys(), ...heldBy.keys(), ...circBy.keys()]);
  for (const q of input.queued) for (const a of q.after ?? []) keys.add(jobKeyOf(a));

  const facts: Fact[] = [];
  const typeFact = (iri: string, label: string, color: string, icon: string): void => {
    for (const [p, o] of [[RDF_TYPE, ENTITY_TYPE], [RDFS_LABEL, label], [`${P}icon`, icon], [`${P}color`, color]] as const)
      facts.push({ s: iri, p, o, created: SCHEMA_CREATED });
  };
  typeFact(DEVICE_JOB_TYPE, 'Device job', '#5b2a86', 'box');
  typeFact(DEVICE_RUN_TYPE, 'Device job run', '#7a5aa6', 'circle');

  for (const key of [...keys].sort()) {
    const def = defs.get(key);
    const run = runningBy.get(key);
    const circ = circBy.get(key);
    const held = heldBy.get(key);
    const q = queuedBy.get(key);
    const runs = (runsBy.get(key) ?? []).slice().sort((a, b) => b.finishedAt.localeCompare(a.finishedAt) || b.id.localeCompare(a.id));
    const state: DeviceJobState = run ? 'running' : circ ? 'given-up' : held ? 'held' : q ? 'queued' : 'idle';
    const reason = state === 'given-up' ? `gave up after ${circ!.count} failures: ${circ!.signature}` : state === 'held' ? held : undefined;
    const iri = jobIri(key);
    const created = run?.started ?? runs[0]?.finishedAt ?? q?.addedAt ?? SCHEMA_CREATED;
    const F = (p: string, o: string, dt?: string): void => { facts.push({ s: iri, p, o, ...(dt ? { dt } : {}), created }); };
    F(RDF_TYPE, DEVICE_JOB_TYPE);
    F(RDFS_LABEL, def?.name ?? key);
    F(`${P}job-state`, state);
    if (reason) F(`${P}state-reason`, reason);
    if (def?.tier) F(`${P}job-tier`, def.tier);
    if (def?.schedule) F(`${P}job-schedule`, def.schedule);
    if (def?.description) F(`${P}job-definition`, def.description.slice(0, 400));
    if (def && def.enabled === false) F(`${P}job-enabled`, 'false');
    const card = cardOf(q);
    if (card) F(`${P}job-card`, card);
    if (run?.started) F(`${P}started`, run.started, XSD_DT);
    // What it waits on: predecessors with no passed run yet.
    for (const a of [...(q?.after ?? [])].sort()) {
      const ak = jobKeyOf(a);
      if (!passedKeys.has(ak) && keys.has(ak)) F(`${P}waits-on`, jobIri(ak));
    }
    F(`${P}run-count`, String(runs.length));
    if (runs.length > RUNS_KEPT) F(`${P}older-runs`, String(runs.length - RUNS_KEPT));

    for (const r of runs.slice(0, RUNS_KEPT)) {
      const rIri = `urn:kbase:concept/device-run-${r.id}`;
      const R = (p: string, o: string, dt?: string): void => { facts.push({ s: rIri, p, o, ...(dt ? { dt } : {}), created: r.finishedAt }); };
      R(RDF_TYPE, DEVICE_RUN_TYPE);
      R(RDFS_LABEL, `${def?.name ?? key} ${r.finishedAt}`);
      R(`${P}run-of`, iri);
      if (r.startedAt) R(`${P}started`, r.startedAt, XSD_DT);
      R(`${P}finished`, r.finishedAt, XSD_DT);
      R(`${P}run-outcome`, r.outcome);
      if (typeof r.exitCode === 'number') R(`${P}exit-code`, String(r.exitCode));
      if (r.reason) R(`${P}outcome-reason`, r.reason);
      if (r.output) R(`${P}output`, r.output);
      // A run made for a space leaps to it only by stable id; a plain folder name is kept as a label, never guessed into a leap.
      if (r.forSpace) {
        if (UUID_RE.test(r.forSpace)) { R(LEAP_PRED, r.forSpace.toLowerCase()); R(LEAP_LABEL_PRED, 'The space this run was made for'); }
        else R(`${P}for-space`, r.forSpace);
      }
      F(`${P}has-run`, rIri);
    }
  }
  return renderSpace(facts, nowMs, { stableId: DEVICE_STABLE_ID, sourceIri: DEVICE_SOURCE_IRI, sourceTitle: DEVICE_SOURCE_TITLE });
}

/** Read the worker's own files (and the two definition files) into a DeviceInput. Nothing is written. */
export function readDeviceInput(dir: string, opts: { jobsTtl?: string; schedulesTtl?: string; alive?: (pid: number) => boolean } = {}): DeviceInput {
  const alive = opts.alive ?? pidAlive;
  const obj = (j: Record<string, unknown> | undefined): Record<string, unknown> => j ?? {};
  const queued: RawQueued[] = [];
  for (const line of readLines(path.join(dir, 'queue.jsonl'))) {
    const j = asJob(line);
    if (!j || !str(j.id) || !str(j.name)) continue;
    queued.push({ id: str(j.id)!, name: str(j.name)!, ...(normAfter(j.after) ? { after: normAfter(j.after) } : {}), ...(j.gpu === false ? { gpu: false } : {}), ...(typeof j.gpuIndex === 'number' ? { gpuIndex: j.gpuIndex } : {}), ...(str(j.addedAt) ? { addedAt: str(j.addedAt) } : {}) });
  }
  const readJson = (f: string): unknown => { try { return JSON.parse(readFileSync(path.join(dir, f), 'utf8')); } catch { return undefined; } };
  const cur = readJson('current.json');
  const running = (Array.isArray(cur) ? cur : [])
    .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object' && typeof (c as Record<string, unknown>).pid === 'number' && alive((c as Record<string, unknown>).pid as number) && !!str((c as Record<string, unknown>).name))
    .map((c) => ({ name: str(c.name)!, started: str(c.started) }));
  const held = new Map<string, string>();
  const worker = obj(readJson('worker.json') as Record<string, unknown> | undefined);
  if (Array.isArray(worker.held)) for (const h of worker.held) {
    if (typeof h !== 'string') continue;
    const i = h.indexOf(': ');
    if (i > 0) held.set(h.slice(0, i), h.slice(i + 2)); else held.set(h, 'held');
  }
  const circuits = new Map<string, { count: number; signature: string }>();
  const circ = readJson('circuits.json');
  if (circ && typeof circ === 'object') for (const [n, v] of Object.entries(circ as Record<string, unknown>)) {
    const c = v as { count?: unknown; signature?: unknown } | null;
    if (c && typeof c.count === 'number') circuits.set(n, { count: c.count, signature: typeof c.signature === 'string' ? c.signature : '' });
  }
  const done: RawRun[] = [];
  for (const line of readLines(path.join(dir, 'queue.done.jsonl'))) {
    const j = asJob(line);
    if (!j || !str(j.id) || !str(j.name) || !str(j.finishedAt)) continue;
    const res = j.result && typeof j.result === 'object' ? (j.result as Record<string, unknown>) : undefined;
    done.push({ id: str(j.id)!, name: str(j.name)!, finishedAt: str(j.finishedAt)!, outcome: str(j.outcome) ?? 'failed',
      ...(str(j.startedAt) ? { startedAt: str(j.startedAt) } : {}), ...(typeof j.exitCode === 'number' ? { exitCode: j.exitCode } : {}),
      ...(str(j.reason) ? { reason: str(j.reason) } : {}), ...(res && str(res.contentId) ? { output: str(res.contentId) } : {}), ...(res && str(res.space) ? { forSpace: str(res.space) } : {}) });
  }
  const defs = parseDefinitions(opts.jobsTtl ?? '', opts.schedulesTtl ?? '');
  return { defs, queued, running, held, circuits, done };
}

/** True when `p` or any parent directory holds a `.git` (a checkout or a worktree). */
export function insideGitCheckout(p: string): boolean {
  let d = path.dirname(path.resolve(p));
  for (;;) {
    if (existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

// ── writer ─────────────────────────────────────────────────────────────────

const defaultQueueDir = (): string =>
  path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'reckons', 'jobs');
const defaultOut = (): string =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'reckons', 'private-workspace', 'kbs', 'job-plan', 'job-plan.ttl');

/** Private output: refuses a path inside a Git checkout, writes mode 0600 (a space can be about private work). */
export function writeAtomic(p: string, text: string): void {
  if (insideGitCheckout(p)) throw new Error(`refusing to write job records inside a Git checkout: ${p}`);
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

const defaultDeviceOut = (): string =>
  path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'reckons', 'device-space', 'kbs', 'this-device', 'job-records.ttl');
const readOr = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

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
  if (args.includes('--device')) {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const jobsTtl = readOr(flag('jobs') ?? path.join(root, 'static', 'reckons-jobs.ttl'));
    const schedulesTtl = readOr(flag('schedules') ?? path.join(mainCheckoutRoot(), 'reckons-workspace', 'schedules.ttl'));
    const dev = readDeviceInput(dir, { jobsTtl, schedulesTtl });
    const devOut = flag('device-out') ?? defaultDeviceOut();
    writeAtomic(devOut, buildDeviceSpaceText(dev, nowMs));
    console.log(`device jobs: ${dev.done.length} run record(s), ${dev.queued.length} queued → ${devOut}`);
  }
  const records = buildRecords(dir, nowMs);
  writeAtomic(out, buildSpaceText(records, nowMs));
  console.log(`job-plan: ${records.length} job(s) → ${out}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
