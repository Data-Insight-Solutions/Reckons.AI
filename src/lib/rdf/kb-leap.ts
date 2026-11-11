/**
 * KB Leap — universal linking from graph entities.
 *
 * A Leap Node is an entity in the current KB that has a bridge to:
 *   - Another KB (via stable ID) — switches to that KB on this device
 *   - An internal app URL (e.g. /?kb=mydb&view=type) — navigates within the app
 *   - An external web URL (https://...) — opens in a new tab
 *
 * Stored as ordinary RDF triples so leaps travel with the KB when exported
 * as Turtle. The leap kind is inferred from the value format, not stored
 * separately.
 *
 * One-to-one: each entity can have at most one leap target at a time.
 */
import type { Statement } from './types';

export const LEAP_PRED       = 'urn:reckons:leap';        // object = target (UUID, app path, or URL)
export const LEAP_LABEL_PRED = 'urn:reckons:leap/label';  // optional human-readable description

export type LeapKind = 'kb' | 'app' | 'url';

export interface KnowledgeBaseLeap {
  /** The raw target value (UUID, app path, or full URL). */
  target: string;
  /** What kind of leap this is. */
  kind: LeapKind;
  /** Human-readable label for the leap, if set. */
  label?: string;
  /** Statement IDs — used to remove the leap via setStatus('rejected'). */
  statementIds: string[];
}

/** Infer the leap kind from the raw target value. */
export function classifyLeap(target: string): LeapKind {
  if (target.startsWith('http://') || target.startsWith('https://')) return 'url';
  if (target.startsWith('/')) return 'app';
  return 'kb'; // UUID stable ID
}

function isActive(s: Statement) {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/** Return the leap for a given entity node key (with or without `i:` prefix), or null. */
export function getLeap(stmts: Statement[], nodeKey: string): KnowledgeBaseLeap | null {
  const iri = nodeKey.startsWith('i:') ? nodeKey.slice(2) : nodeKey;
  const targetSt = stmts.find(
    s => s.s.kind === 'iri' && s.s.value === iri && s.p.value === LEAP_PRED && isActive(s)
  );
  if (!targetSt) return null;
  const labelSt = stmts.find(
    s => s.s.kind === 'iri' && s.s.value === iri && s.p.value === LEAP_LABEL_PRED && isActive(s)
  );
  const target = targetSt.o.value;
  return {
    target,
    kind: classifyLeap(target),
    label: labelSt?.o.value,
    statementIds: [targetSt.id, ...(labelSt ? [labelSt.id] : [])]
  };
}

/** Returns the set of node keys (with `i:` prefix) that have an active leap. */
export function leapNodeKeys(stmts: Statement[]): Set<string> {
  const keys = new Set<string>();
  for (const s of stmts) {
    if (s.p.value === LEAP_PRED && s.s.kind === 'iri' && isActive(s)) {
      keys.add('i:' + s.s.value);
    }
  }
  return keys;
}

// ── F269.2 device leaps — "This device", reached from a space a job runs for ──────
//
// A space a job runs for holds that job's MAIN DEFINITION as a node, and that node carries a
// leap to the same job's detail in "This device" (kb:job-definition-leap, static/reckons-roadmap.ttl).
//
// THE LEAP NAMES NO DEVICE. A space can be shared and opened on another machine, so the target
// is a RESERVED NAME meaning "the device space on the device you are on now", resolved only when
// it is followed — never a particular device's id. The reserved name travels with the space, so
// it survives export to, and import on, another browser profile and still means the same thing
// there (the done-test). We keep the constant local rather than importing from
// src/lib/storage: kb-leap.ts is a pure RDF helper and the storage layer (Dexie, localStorage)
// must not flow into it. The space-naming param here is `kb`, the same param resolveDbName()
// (src/lib/storage/db.ts) and kbUrl() (src/lib/storage/kb-registry.ts) read — so the reserved
// name lands in the exact slot the app already understands.
export const DEVICE_SPACE_RESERVED = 'this-device'; // the reserved name; never a device id
const DEVICE_JOB_PARAM = 'select';                   // the job id to select on arrival
const SPACE_PARAM = 'kb';                            // the param that names a space (see above)

/**
 * The in-app leap target a job's definition node carries to "This device". Shapes like the
 * `kb`/`view` app links kbUrl() already builds: it names the device space by its reserved name
 * (the `kb` param) and carries the job id to select on arrival. Contains no device id and no
 * stable id — classifyLeap() reads it as an 'app' leap, and it resolves to the real device
 * space on whatever device follows it.
 */
export function deviceLeapTarget(jobId: string): string {
  return `/?${SPACE_PARAM}=${DEVICE_SPACE_RESERVED}&${DEVICE_JOB_PARAM}=${encodeURIComponent(jobId)}`;
}

/** The job a device-leap target selects. */
export interface DeviceLeapJob {
  jobId: string;
}

/**
 * Recognise a device-leap target and read the job it selects. Returns null for every other
 * kind of leap target — a space's stable id, an external URL, an app path that does not name
 * the reserved device space, or one that names it without selecting a job — so callers can
 * tell a device leap from an ordinary leap without special-casing the rest.
 */
export function parseDeviceLeap(target: string): DeviceLeapJob | null {
  if (classifyLeap(target) !== 'app') return null; // a device leap is an in-app path
  let url: URL;
  try {
    url = new URL(target, 'http://device.leap'); // a base so the relative search params parse
  } catch {
    return null;
  }
  if (url.searchParams.get(SPACE_PARAM) !== DEVICE_SPACE_RESERVED) return null;
  const jobId = url.searchParams.get(DEVICE_JOB_PARAM);
  return jobId ? { jobId } : null;
}

/**
 * What to do on a device when a device-leap target is followed: open the registered device
 * space and select the job there, or say plainly that this device has no device space and go
 * nowhere. Never falls back to an ordinary space, and never invents a job.
 */
export type DeviceLeapResolution =
  | { kind: 'open'; spaceId: string; select: string }
  | { kind: 'no-device-space' };

export function resolveDeviceLeap(target: string, deviceSpaceId: string | null): DeviceLeapResolution {
  const job = parseDeviceLeap(target);
  if (!deviceSpaceId || !job) return { kind: 'no-device-space' };
  return { kind: 'open', spaceId: deviceSpaceId, select: job.jobId };
}
