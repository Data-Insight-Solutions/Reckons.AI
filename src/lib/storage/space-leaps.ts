/**
 * Count leaps in spaces other than the current one (F218 Spaces map) — on demand only.
 *
 * Every space is its own IndexedDB database and statements are indexed by [subject+predicate], not
 * by predicate alone, so counting a space's leaps means reading all of its statements. That is fine
 * once, when a person asks for it; it is not fine on every visit to the Spaces tab. So the map
 * records the CURRENT space automatically (its statements are already in memory) and this runs only
 * from an explicit "count leaps in every space" action, one space at a time, reporting progress.
 */
import { KBaseDB } from './db';
import { getRegistry, recordLeapTargets } from './kb-registry';
import { leapTargetCounts } from '../rdf/space-graph';
import { LEAP_PRED } from '../rdf/kb-leap';
import type { Statement } from '../rdf/types';

export async function countLeapsInSpace(id: string): Promise<Record<string, number>> {
  const db = new KBaseDB(id);
  try {
    const leaps = (await db.statements.filter((s: Statement) => s.p.value === LEAP_PRED).toArray()) as Statement[];
    return leapTargetCounts(leaps);
  } finally {
    db.close();
  }
}

/** Count and record every registered space. Returns how many were counted and which failed. */
export async function countLeapsInAllSpaces(
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ counted: number; failed: string[] }> {
  const spaces = getRegistry();
  const failed: string[] = [];
  let counted = 0;
  for (const [i, space] of spaces.entries()) {
    onProgress?.(i, spaces.length, space.name);
    try {
      recordLeapTargets(space.id, await countLeapsInSpace(space.id));
      counted++;
    } catch {
      failed.push(space.name);
    }
  }
  onProgress?.(spaces.length, spaces.length, '');
  return { counted, failed };
}
