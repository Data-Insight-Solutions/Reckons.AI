/**
 * Currents settings persistence (F29.3) — replaces the graph's
 * `urn:reckons:meta/currents/*` statements with a new CurrentsSettings snapshot.
 *
 * Kept separate from currents.ts (core model, do not modify) because this module
 * reaches into the kb store (addStatements/updateStatement) to actually write.
 * The diff itself is a pure function so it can be unit-tested without a DB.
 *
 * Statement ids from currentsSettingsToStatements are deterministic
 * (`currents|<subject>|<predicate>|<value>`), so an unchanged entry produces the
 * exact same id on every write — the diff only touches what actually changed.
 */

import type { Statement } from './types';
import { CURRENTS_META_PREFIX, currentsSettingsToStatements, type CurrentsSettings } from './currents';

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

export interface CurrentsSettingsDiff {
  /** Ids of currently-active currents/* statements that are absent from the new settings. */
  toReject: string[];
  /** Ids that exist (rejected/superseded from an earlier edit) but reappear unchanged in the new settings. */
  toRevive: string[];
  /** Brand-new statements to insert. */
  toAdd: Statement[];
}

/**
 * Compute the minimal edit that brings the graph's currents/* meta statements
 * in line with `next`. Pure — no store access, safe to unit test directly.
 */
export function diffCurrentsSettings(existing: Statement[], next: CurrentsSettings): CurrentsSettingsDiff {
  const relevant = existing.filter((s) => s.p.value.startsWith(CURRENTS_META_PREFIX));
  const byId = new Map(relevant.map((s) => [s.id, s]));
  const nextStatements = currentsSettingsToStatements(next);
  const nextIds = new Set(nextStatements.map((s) => s.id));

  const toReject = relevant.filter((s) => isActive(s) && !nextIds.has(s.id)).map((s) => s.id);

  const toRevive: string[] = [];
  const toAdd: Statement[] = [];
  for (const s of nextStatements) {
    const cur = byId.get(s.id);
    if (cur && isActive(cur)) continue; // already active and identical — untouched
    if (cur) toRevive.push(s.id);
    else toAdd.push(s);
  }

  return { toReject, toRevive, toAdd };
}

/**
 * Persist new currents settings to the active graph. Settings statements are
 * always status 'confirmed' — they're graph configuration, not reviewed content.
 */
export async function replaceCurrentsSettings(next: CurrentsSettings): Promise<void> {
  const { statements, updateStatement, addStatements } = await import('../stores/kb.svelte');
  const diff = diffCurrentsSettings(statements(), next);
  for (const id of diff.toReject) await updateStatement(id, { status: 'rejected' });
  for (const id of diff.toRevive) await updateStatement(id, { status: 'confirmed' });
  if (diff.toAdd.length > 0) await addStatements(diff.toAdd);
}
