/**
 * MODEL ROUTING by job kind, and the per-model RAM start gate (F74.6, kb:model-routing-ledger; 2026-11-13).
 *
 * Matt, 2026-11-13: "We need to do good routing to qwen coder, or specialized models anyway, using smaller
 * models may not be a problem for many job types." The table (kind -> ordered candidate models, each with its
 * evidence and whether that evidence is measured or a guess) is DATA in static/reckons-jobs.ttl
 * (ktype:JobKind, ktype:ModelRoute); this file reads it and decides. A schedule or job declares
 * kpred:job-kind (or an explicit kpred:job-model override) instead of hard-coding a model.
 *
 * THE PER-MODEL GATE replaces the flat 16 GiB start gate for jobs that declare a kind or model: a job starts
 * only when MemAvailable >= the model's size (read from Ollama's /api/tags) + the floor (ramFloorAvailMiB,
 * 2 GiB). A 2 to 9 GB model therefore runs with the desktop open; a 15 to 19 GB one waits for room. A model that
 * is already resident (Ollama /api/ps) needs no new room. WEAKNESS: size is the file size, not the load footprint
 * (KV cache for a long context adds to it), so the floor is the only margin; and a job with no kind or model still
 * meets the flat gate, because nothing says which model it will call.
 *
 * Pure functions here; the worker (queue-worker.ts) supplies the live sizes and RAM.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Parser } from 'n3';
import { queueDir } from './session-queue.js';

const P = 'urn:kbase:predicate/';
const TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const ORDER = 'urn:reckons:nav/order';
const MIB = 1048576;

export type EvidenceGrade = 'measured' | 'guess';
export type Candidate = { model: string; grade: EvidenceGrade; evidence: string };
export type KindRoutes = { kind: string; local: boolean; candidates: Candidate[]; note?: string };
export type RoutingTable = Map<string, KindRoutes>;

/** Read the routing table out of a jobs graph. A route naming an unknown kind, or with no model, is an error, never skipped. Pure. */
export function parseRoutingTable(ttl: string): RoutingTable {
  const by = new Map<string, Record<string, string>>();
  for (const q of new Parser().parse(ttl)) {
    const p = q.predicate.value;
    const key = p === TYPE ? 'type' : p === LABEL ? 'label' : p === ORDER ? 'order' : p.startsWith(P) ? p.slice(P.length) : '';
    if (!key) continue;
    const o = by.get(q.subject.value) ?? {};
    o[key] = q.object.value;
    by.set(q.subject.value, o);
  }
  const table: RoutingTable = new Map();
  const kindIri = new Map<string, string>();
  for (const [iri, o] of by) {
    if (o.type !== 'urn:kbase:type/JobKind') continue;
    if (!o.label) throw new Error(`routing: ${iri} has no rdfs:label`);
    table.set(o.label, { kind: o.label, local: o['route-local'] !== 'false', candidates: [], ...(o['honest-note'] ? { note: o['honest-note'] } : {}) });
    kindIri.set(iri, o.label);
  }
  const routes: { kind: string; order: number; c: Candidate }[] = [];
  for (const [iri, o] of by) {
    if (o.type !== 'urn:kbase:type/ModelRoute') continue;
    const kind = kindIri.get(o['route-kind'] ?? '');
    if (!kind) throw new Error(`routing: ${iri} names an unknown job kind ${o['route-kind']}`);
    if (!o.model) throw new Error(`routing: ${iri} has no kpred:model`);
    if (o['evidence-grade'] !== 'measured' && o['evidence-grade'] !== 'guess') throw new Error(`routing: ${iri} needs kpred:evidence-grade measured|guess`);
    if (!o.evidence) throw new Error(`routing: ${iri} has no kpred:evidence`);
    routes.push({ kind, order: Number(o.order ?? 1e6), c: { model: o.model, grade: o['evidence-grade'], evidence: o.evidence } });
  }
  for (const r of routes.sort((a, b) => a.order - b.order)) table.get(r.kind)!.candidates.push(r.c);
  for (const k of table.values()) if (k.local && !k.candidates.length) throw new Error(`routing: kind ${k.kind} says it has a local route but lists no model`);
  return table;
}

export const jobsGraphFile = (root = process.cwd()): string => path.join(root, 'static', 'reckons-jobs.ttl');
export const readRoutingTable = (root = process.cwd()): RoutingTable => parseRoutingTable(readFileSync(jobsGraphFile(root), 'utf8'));

/** Ollama names a bare model `name:latest`; compare on that form. */
export const normalizeModel = (m: string): string => (m.includes(':') ? m : `${m}:latest`);

/** name -> bytes from Ollama's /api/tags. Null when Ollama cannot say (so callers fall back to the flat gate). */
export async function fetchModelSizes(base: string, fetchFn: typeof fetch = fetch): Promise<Map<string, number> | null> {
  try {
    const res = await fetchFn(`${base.replace(/\/+$/, '')}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { models?: { name?: string; size?: number }[] };
    const out = new Map<string, number>();
    for (const m of body.models ?? []) if (m.name && typeof m.size === 'number') out.set(normalizeModel(m.name), m.size);
    return out;
  } catch { return null; }
}

/** Names Ollama has loaded now (/api/ps): these need no new RAM to start a job. */
export async function fetchResidentModels(base: string, fetchFn: typeof fetch = fetch): Promise<Set<string>> {
  try {
    const res = await fetchFn(`${base.replace(/\/+$/, '')}/api/ps`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return new Set();
    const body = (await res.json()) as { models?: { name?: string }[] };
    return new Set((body.models ?? []).map((m) => normalizeModel(m.name ?? '')).filter(Boolean));
  } catch { return new Set(); }
}

export const DEFAULT_FLOOR_MIB = 2048;
const gib = (mib: number): string => `${(mib / 1024).toFixed(1)} GiB`;

export type ModelGate = { ok: true; needMiB: number } | { ok: false; needMiB: number; reason: string };

/** THE PER-MODEL START GATE: available RAM must cover the model's size plus the floor, unless the model is already resident. Unknown RAM passes (non-Linux). Pure. */
export function modelStartVerdict(availMiB: number | null, sizeBytes: number, floorMiB = DEFAULT_FLOOR_MIB, resident = false): ModelGate {
  const needMiB = Math.ceil(sizeBytes / MIB) + floorMiB;
  if (resident || availMiB === null || availMiB >= needMiB) return { ok: true, needMiB };
  return { ok: false, needMiB, reason: `system RAM available ${gib(availMiB)} < ${gib(needMiB)} (model ${gib(Math.ceil(sizeBytes / MIB))} + floor ${gib(floorMiB)})` };
}

export type RouteInput = {
  kind?: string; override?: string; table: RoutingTable; sizes: Map<string, number> | null; availMiB: number | null; floorMiB?: number; resident?: Set<string>;
};
export type RouteChoice =
  | { ok: true; model: string; rung: number; grade: EvidenceGrade | 'override'; needMiB: number; skipped: string[] }
  | { ok: false; code: 'no-local-route' | 'unknown-kind' | 'not-installed' | 'wait' | 'sizes-unknown'; reason: string; skipped: string[] };

/**
 * Choose a model for a job. An explicit override is never substituted: it runs if installed and fitting, else the
 * job waits or fails naming it. Otherwise the first candidate (in table order) that is installed and fits wins;
 * `rung` is its 1-based position, so a kind that mostly lands on rung 3 is visible in the ledger. When nothing fits
 * the job WAITS (code 'wait') for room rather than starting an unfit model. Pure.
 */
export function chooseRoute(i: RouteInput): RouteChoice {
  const floor = i.floorMiB ?? DEFAULT_FLOOR_MIB;
  const skipped: string[] = [];
  if (!i.sizes) return { ok: false, code: 'sizes-unknown', reason: 'Ollama did not report installed model sizes', skipped };
  const cands: { model: string; rung: number; grade: EvidenceGrade | 'override' }[] = [];
  if (i.override) cands.push({ model: i.override, rung: 0, grade: 'override' });
  else {
    const k = i.kind ? i.table.get(i.kind) : undefined;
    if (!k) return { ok: false, code: 'unknown-kind', reason: `no job kind "${i.kind ?? ''}" in the routing table`, skipped };
    if (!k.local) return { ok: false, code: 'no-local-route', reason: `kind ${k.kind} has no local route${k.note ? `: ${k.note}` : ''}`, skipped };
    k.candidates.forEach((c, n) => cands.push({ model: c.model, rung: n + 1, grade: c.grade }));
  }
  let installedButFull: string | null = null;
  for (const c of cands) {
    const size = i.sizes.get(normalizeModel(c.model));
    if (size === undefined) { skipped.push(`${c.model}: not installed`); continue; }
    const g = modelStartVerdict(i.availMiB, size, floor, i.resident?.has(normalizeModel(c.model)) ?? false);
    if (g.ok) return { ok: true, model: c.model, rung: c.rung, grade: c.grade, needMiB: g.needMiB, skipped };
    skipped.push(`${c.model}: ${g.reason}`);
    installedButFull ??= g.reason;
  }
  if (installedButFull) return { ok: false, code: 'wait', reason: `waiting for room: ${skipped.join('; ')}`, skipped };
  return { ok: false, code: 'not-installed', reason: `no candidate installed: ${skipped.join('; ')}`, skipped };
}

// ── the ledger (kb:model-routing-ledger: "each attempt and its rung is recorded") ──────────────────────────────
export type RouteAttempt = { at: string; job: string; kind?: string; model: string; rung: number; grade: string; outcome: string; reason?: string };
export const routeLedgerPath = (): string => path.join(queueDir(), 'route-attempts.jsonl');

export function recordRouteAttempt(a: RouteAttempt, file = routeLedgerPath()): void {
  try { mkdirSync(path.dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify(a)}\n`); } catch { /* the ledger never fails a job */ }
}

export function readRouteLedger(file = routeLedgerPath()): RouteAttempt[] {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return []; }
  const out: RouteAttempt[] = [];
  for (const line of text.split('\n')) { try { const a = JSON.parse(line) as RouteAttempt; if (a && typeof a.model === 'string' && typeof a.job === 'string') out.push(a); } catch { /* skip */ } }
  return out;
}

/** Kinds whose attempts keep failing or keep landing past rung 1: the evidence for a new model or script. Pure. */
export function climbingKinds(attempts: RouteAttempt[], minAttempts = 3): { kind: string; attempts: number; failed: number; meanRung: number }[] {
  const by = new Map<string, RouteAttempt[]>();
  for (const a of attempts) if (a.kind) by.set(a.kind, [...(by.get(a.kind) ?? []), a]);
  const out: { kind: string; attempts: number; failed: number; meanRung: number }[] = [];
  for (const [kind, xs] of by) {
    const failed = xs.filter((x) => x.outcome !== 'passed').length;
    const meanRung = xs.reduce((s, x) => s + x.rung, 0) / xs.length;
    if (xs.length >= minAttempts && (failed / xs.length >= 0.5 || meanRung >= 2)) out.push({ kind, attempts: xs.length, failed, meanRung: Math.round(meanRung * 10) / 10 });
  }
  return out;
}
