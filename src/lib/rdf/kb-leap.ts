/**
 * KB Leap — inter-KB linking.
 *
 * A Leap Node is an entity in the current KB that has a bridge pointing to
 * another KB's stable ID. Stored as ordinary RDF triples so leaps travel
 * with the KB when exported as Turtle.
 *
 * One-to-one: each entity can have at most one leap target at a time.
 */
import type { Statement } from './types';

export const LEAP_PRED       = 'urn:reckons:leap';        // object = target KB stable ID (literal)
export const LEAP_LABEL_PRED = 'urn:reckons:leap/label';  // optional human-readable description

export interface KbLeap {
  /** The stable ID of the target KB (full UUID string). */
  targetKbId: string;
  /** Human-readable label for the leap, if set. */
  label?: string;
  /** Statement IDs — used to remove the leap via setStatus('rejected'). */
  statementIds: string[];
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
  return {
    targetKbId: targetSt.o.value,
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
