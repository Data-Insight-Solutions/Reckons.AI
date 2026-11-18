/**
 * DEVICE CAPABILITIES (F269, F303.2) — the pure core: terms, the reader of the device space, and the match.
 *
 * "MEASURED, NOT DECLARED" (F303): a device claims nothing that needs a capability unless a probe
 * measured it. So there are three states for a term, never two: measured with a value, measured
 * absent (the probe looked and it was not there), and unmeasured (the probe could not look). Only the
 * first satisfies a need. Terms are defined once in static/reckons-capabilities.ttl; this file holds
 * no device value, and the file it builds goes to the private device space, outside Git.
 *
 * Nothing here touches the machine; measure-device.ts does the probing and device-space-build.ts writes the TTL.
 * This file stays light (n3 only) so the job runtime and the MCP tools can read the device space cheaply. Every function is pure.
 */
import { Parser } from 'n3';

export const P = 'urn:kbase:predicate/';
export const MEASUREMENT_TYPE = 'urn:kbase:type/Measurement';
export const DEVICE_TYPE = 'urn:kbase:type/Device';
const CAP_NS = 'urn:kbase:capability/';
export const DEVICE_IRI = 'urn:kbase:concept/this-device';

/** A term id: 'ram-gib', 'gpu-memory-gib', 'tool:blender', 'model:qwen3-coder'. */
export type CapabilityTerm = string;
/** What a probe found for one term: a number, `true` (present) or `false` (looked, not there). */
export type MeasuredValue = number | boolean;
export type Measured = { measuredAt: string; values: Record<CapabilityTerm, MeasuredValue> };

/** What the probes read, before it becomes terms. Every field optional: a probe that could not run is absent. */
export type RawMeasurements = {
  measuredAt: string;
  ramTotalBytes?: number;
  ramAvailableBytes?: number;
  gpuMemoryMiB?: number[];
  diskFreeBytes?: number;
  /** Names from the model server, or undefined when it could not be reached. */
  models?: string[];
  /** Tool name -> found. Only tools the probe actually looked for. */
  tools?: Record<string, boolean>;
};

const GIB = 1024 ** 3;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The model name as a term: lower case, spaces trimmed. A model keeps its tag (name:tag). */
export const modelTerm = (name: string): CapabilityTerm => `model:${name.trim().toLowerCase()}`;
export const toolTerm = (name: string): CapabilityTerm => `tool:${name.trim().toLowerCase()}`;

/** Raw probe output to capability terms. Pure. An unprobed quantity gets no term (unmeasured). */
export function measurementsToValues(raw: RawMeasurements): Measured {
  const v: Record<CapabilityTerm, MeasuredValue> = {};
  if (raw.ramTotalBytes !== undefined) v['ram-gib'] = round1(raw.ramTotalBytes / GIB);
  if (raw.ramAvailableBytes !== undefined) v['ram-available-gib'] = round1(raw.ramAvailableBytes / GIB);
  if (raw.gpuMemoryMiB !== undefined) {
    v['gpu-count'] = raw.gpuMemoryMiB.length;
    v['gpu-memory-gib'] = round1(Math.max(0, ...raw.gpuMemoryMiB) / 1024);
    v['gpu-memory-total-gib'] = round1(raw.gpuMemoryMiB.reduce((a, b) => a + b, 0) / 1024);
  }
  if (raw.diskFreeBytes !== undefined) v['disk-free-gib'] = round1(raw.diskFreeBytes / GIB);
  for (const m of raw.models ?? []) v[modelTerm(m)] = true;
  for (const [t, found] of Object.entries(raw.tools ?? {})) v[toolTerm(t)] = found;
  return { measuredAt: raw.measuredAt, values: v };
}

/** term id <-> IRI. 'tool:blender' is urn:kbase:capability/tool/blender; a model tag keeps its colon. */
export function termIri(term: CapabilityTerm): string {
  const i = term.indexOf(':');
  return CAP_NS + (i < 0 ? term : `${term.slice(0, i)}/${encodeURIComponent(term.slice(i + 1))}`);
}
export function iriTerm(iri: string): CapabilityTerm | undefined {
  if (!iri.startsWith(CAP_NS)) return undefined;
  const rest = iri.slice(CAP_NS.length);
  const i = rest.indexOf('/');
  return i < 0 ? rest : `${rest.slice(0, i)}:${decodeURIComponent(rest.slice(i + 1))}`;
}

/** subject, predicate, object (as text) of every reified statement block in an annotated space file. Pure. */
export function reifiedTriples(ttl: string): { s: string; p: string; o: string }[] {
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const by = new Map<string, { s?: string; p?: string; o?: string }>();
  for (const q of new Parser().parse(ttl)) {
    const k = q.predicate.value;
    if (k !== `${RDF}subject` && k !== `${RDF}predicate` && k !== `${RDF}object`) continue;
    const e = by.get(q.subject.value) ?? {};
    e[k.endsWith('subject') ? 's' : k.endsWith('predicate') ? 'p' : 'o'] = q.object.value;
    by.set(q.subject.value, e);
  }
  return [...by.values()].filter((e): e is { s: string; p: string; o: string } => e.s !== undefined && e.p !== undefined && e.o !== undefined);
}

/** Read the measured values back out of the device space text. Pure; unparseable text throws (a caller decides). */
export function readMeasuredSpace(ttl: string): Measured {
  const by = new Map<string, { cap?: string; value?: MeasuredValue }>();
  let measuredAt = '';
  for (const { s, p, o } of reifiedTriples(ttl)) {
    if (s === DEVICE_IRI && p === `${P}measured`) { measuredAt = o; continue; }
    if (!s.startsWith('urn:kbase:concept/measured-')) continue;
    const e = by.get(s) ?? {};
    if (p === `${P}capability`) e.cap = o;
    if (p === `${P}measured-value`) e.value = o === 'true' ? true : o === 'false' ? false : Number.isFinite(Number(o)) ? Number(o) : undefined;
    by.set(s, e);
  }
  const values: Record<CapabilityTerm, MeasuredValue> = {};
  for (const e of by.values()) {
    const term = e.cap ? iriTerm(e.cap) : undefined;
    if (term && e.value !== undefined) values[term] = e.value;
  }
  return { measuredAt, values };
}

// ── the match (F303.2) ─────────────────────────────────────────────────────

/** One thing a job needs: a presence (installed) or, with `atLeast`, a number the device must meet. */
export type Need = { term: CapabilityTerm; atLeast?: number };
export type MatchResult = { verdict: 'can-run' } | { verdict: 'cannot-run'; reasons: string[] };

/**
 * Can a device that measured `measured` satisfy `needs`? Pure. Every unmet need gives a reason, so a
 * refusal says what is missing and whether it was absent or simply never measured. No needs: can-run.
 */
export function matchCapabilities(needs: Need[], measured: Measured | undefined): MatchResult {
  const reasons: string[] = [];
  for (const n of needs) {
    const v = measured?.values[n.term];
    if (v === undefined) { reasons.push(`${n.term}: not measured on this device`); continue; }
    if (n.atLeast !== undefined) {
      if (typeof v !== 'number') reasons.push(`${n.term}: measured as ${v}, a number was needed`);
      else if (v < n.atLeast) reasons.push(`${n.term}: needs at least ${n.atLeast}, measured ${v}`);
    } else if (v === false) reasons.push(`${n.term}: measured absent`);
    else if (typeof v === 'number' && v <= 0) reasons.push(`${n.term}: measured as ${v}`);
  }
  return reasons.length ? { verdict: 'cannot-run', reasons } : { verdict: 'can-run' };
}
