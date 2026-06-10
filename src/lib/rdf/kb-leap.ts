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

export interface KbLeap {
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
export function getLeap(stmts: Statement[], nodeKey: string): KbLeap | null {
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
