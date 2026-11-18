/**
 * F303.1 — the cross-device request: the pure validator.
 *
 * It layers on validateJobRequest (F74.14), which already refuses an unknown job kind and builds the
 * command only from the defined job's fixed template. This adds what a request that crosses devices
 * must carry and prove:
 *   - requester: an opaque device id (a UUID, never a hostname or user name);
 *   - createdAt: a date, not more than a day ahead;
 *   - needs: capability terms (+ a minimum for numeric ones), each a term static/reckons-capabilities.ttl
 *     defines (or a tool:/model: name), so a typo is refused instead of silently unsatisfiable;
 *   - inputs: files by content hash (sha256), paths relative to the workspace, no escape;
 *   - signature: a FIELD that F196.2 will fill. Signing does not exist yet, so TODAY an unsigned request
 *     is accepted only from THIS device's own id, and any other device's request is refused, signed or
 *     not (a signature nobody can verify is not a signature). Nothing from another machine runs before
 *     signing is built.
 * Pure: no files, no clock (the caller passes `now`). The input hashes are checked against the files by
 * verifyInputs in scripts/agent/cross-device-inputs.ts, which does read files.
 */
import { Parser } from 'n3';
import { validateJobRequest, type ChannelJob, type JobRequest, type ValidatedJobRequest } from './job-request.js';
import type { Need } from '../device-capabilities.js';

const DEVICE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const NAME_RE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
export const MAX_NEEDS = 16;
export const MAX_INPUTS = 16;
const DAY_MS = 86_400_000;

export type CapabilityTerms = {
  numeric: ReadonlySet<string>;
  presence: ReadonlySet<string>;
  /** Open families: 'tool' and 'model' (term = family:name). */
  families: ReadonlySet<string>;
};

/** The terms the capability graph defines, from its text. Pure; unparseable text throws. */
export function readCapabilityTerms(ttl: string): CapabilityTerms {
  const K = 'urn:kbase:predicate/';
  const by = new Map<string, { label?: string; kind?: string }>();
  for (const q of new Parser().parse(ttl)) {
    const e = by.get(q.subject.value) ?? {};
    if (q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#label') e.label = q.object.value;
    if (q.predicate.value === `${K}capability-kind`) e.kind = q.object.value;
    by.set(q.subject.value, e);
  }
  const numeric = new Set<string>(), presence = new Set<string>(), families = new Set<string>();
  for (const { label, kind } of by.values()) {
    if (!label || !kind) continue;
    const fam = /^([a-z]+):<name>$/.exec(label);
    if (fam) families.add(fam[1]!);
    else if (kind === 'numeric') numeric.add(label);
    else presence.add(label);
  }
  return { numeric, presence, families };
}

export type CrossDeviceRequest = JobRequest & { requester?: unknown; createdAt?: unknown; needs?: unknown; inputs?: unknown; signature?: unknown };
export type InputRef = { path: string; sha256: string };
export type ValidatedCrossDeviceRequest = ValidatedJobRequest & {
  requester: string; createdAt: string; needs: Need[]; inputs: InputRef[];
  /** Always false today: no signature is verified (F196.2 not built). */
  signed: false;
};
export type CrossDeviceResult = ValidatedCrossDeviceRequest | { ok: false; reason: string };

export type CrossDeviceContext = {
  thisDeviceId: string;
  terms: CapabilityTerms;
  jobs?: Readonly<Record<string, ChannelJob>>;
  spaces?: readonly string[];
  now: Date;
};

const refuse = (reason: string) => ({ ok: false as const, reason });
const show = (v: unknown): string => JSON.stringify(v)?.slice(0, 40) ?? 'undefined';

export function validateCrossDeviceRequest(request: CrossDeviceRequest, ctx: CrossDeviceContext): CrossDeviceResult {
  const base = validateJobRequest(request, ctx.jobs, { spaces: ctx.spaces });
  if (!base.ok) return base;
  const r = request as Record<string, unknown>;

  if (typeof r.requester !== 'string' || !DEVICE_RE.test(r.requester)) {
    return refuse('requester must be an opaque device id (a lowercase UUID), never a host or user name');
  }
  const requester = r.requester;
  if (requester !== ctx.thisDeviceId) {
    // Signing is F196.2 and is not built: another device's request is refused whether or not it
    // carries a signature, because there is nothing here that could check one.
    return refuse('a request from another device is refused: signatures are not verified yet (F196.2 is not built), so only this device\'s own requests run');
  }

  const at = typeof r.createdAt === 'string' ? Date.parse(r.createdAt) : NaN;
  if (!Number.isFinite(at)) return refuse('createdAt must be a date');
  if (at - ctx.now.getTime() > DAY_MS) return refuse('createdAt is more than a day in the future');

  if (r.signature !== undefined && r.signature !== null && (typeof r.signature !== 'string' || r.signature.length > 2000)) {
    return refuse('signature must be text of at most 2000 characters, or absent');
  }

  const needs = parseNeeds(r.needs, ctx.terms);
  if (!Array.isArray(needs)) return needs;
  const inputs = parseInputs(r.inputs);
  if (!Array.isArray(inputs)) return inputs;

  return { ...base, requester, createdAt: new Date(at).toISOString(), needs, inputs, signed: false };
}

function parseNeeds(raw: unknown, terms: CapabilityTerms): Need[] | { ok: false; reason: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return refuse('needs must be a list');
  if (raw.length > MAX_NEEDS) return refuse(`needs may list at most ${MAX_NEEDS} terms`);
  const out: Need[] = [];
  for (const n of raw) {
    if (typeof n !== 'object' || n === null || Array.isArray(n)) return refuse('each need must be an object with a term');
    const o = n as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'term' && k !== 'atLeast') return refuse(`a need may only have term and atLeast, not ${show(k)}`);
    if (typeof o.term !== 'string') return refuse('a need must name a term');
    const term = o.term;
    const i = term.indexOf(':');
    const family = i > 0 ? term.slice(0, i) : undefined;
    let numeric: boolean;
    if (family !== undefined) {
      if (!terms.families.has(family) || !NAME_RE.test(term.slice(i + 1))) return refuse(`need ${show(term)} is not a capability term`);
      numeric = false;
    } else if (terms.numeric.has(term)) numeric = true;
    else if (terms.presence.has(term)) numeric = false;
    else return refuse(`need ${show(term)} is not a capability term`);
    if (o.atLeast !== undefined) {
      if (!numeric) return refuse(`need ${show(term)} is a presence term and takes no minimum`);
      if (typeof o.atLeast !== 'number' || !Number.isFinite(o.atLeast) || o.atLeast < 0 || o.atLeast > 1e9) return refuse(`the minimum for ${show(term)} must be a number from 0 up`);
      out.push({ term, atLeast: o.atLeast });
    } else out.push({ term });
  }
  return out;
}

function parseInputs(raw: unknown): InputRef[] | { ok: false; reason: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return refuse('inputs must be a list');
  if (raw.length > MAX_INPUTS) return refuse(`inputs may list at most ${MAX_INPUTS} files`);
  const out: InputRef[] = [];
  for (const n of raw) {
    if (typeof n !== 'object' || n === null || Array.isArray(n)) return refuse('each input must be an object with path and sha256');
    const o = n as Record<string, unknown>;
    for (const k of Object.keys(o)) if (k !== 'path' && k !== 'sha256') return refuse(`an input may only have path and sha256, not ${show(k)}`);
    if (typeof o.path !== 'string' || o.path.length > 200 || !PATH_RE.test(o.path) || o.path.split('/').some((s) => s === '.' || s === '..')) {
      return refuse('an input path must be relative to the workspace, with no dot segments');
    }
    if (typeof o.sha256 !== 'string' || !SHA_RE.test(o.sha256)) return refuse('an input needs the sha256 of its content (64 lowercase hex characters)');
    out.push({ path: o.path, sha256: o.sha256 });
  }
  return out;
}
