/**
 * Count leaps in spaces other than the current one (F218 Spaces map), in the background.
 *
 * Every space is its own IndexedDB database and statements are indexed by [subject+predicate], not
 * by predicate alone, so counting a space's leaps means reading its statements once. That is done
 * automatically, one space at a time with a pause between spaces so the page stays responsive, and
 * only for spaces never counted or written to since their last count. The first version asked the
 * person to press "count leaps in every space"; Matt, 2026-09-29, was confused by the button and saw
 * no edges, because nothing outside the current space was counted until someone pressed it.
 *
 * Counting also reads each space's own stable id from its settings. Edges are matched by stable id,
 * and the registry otherwise learns a space's id only when that space is opened on this device, via
 * Drive sync, or on import — so a leap into a space never opened here would look unresolved.
 */
import Dexie from 'dexie';
import { v4 as uuid } from 'uuid';
import { KBaseDB, DEFAULT_SETTINGS } from './db';
import { getRegistry, recordLeapTargets, registerStableId, type KbEntry } from './kb-registry';
import { leapTargetCounts } from '../rdf/space-graph';
import { LEAP_PRED } from '../rdf/kb-leap';
import type { Statement } from '../rdf/types';

/** A space registered here whose database does not exist on this device (e.g. known only from a synced folder). */
export class SpaceNotOnDevice extends Error {
  constructor(id: string) { super(`no data for "${id}" on this device yet — open it once to load it`); this.name = 'SpaceNotOnDevice'; }
}

export async function countLeapsInSpace(id: string): Promise<{ counts: Record<string, number>; stableId?: string }> {
  // Opening a database that does not exist CREATES it, empty. Check first, so reading the map never
  // leaves behind an empty database for a space that lives only in a workspace folder or in Drive.
  if (!(await Dexie.exists(id))) throw new SpaceNotOnDevice(id);
  const db = new KBaseDB(id);
  try {
    const leaps = (await db.statements.filter((s: Statement) => s.p.value === LEAP_PRED).toArray()) as Statement[];
    const settings = await db.settings.get('main');
    let stableId = settings?.kbStableId || undefined;
    // A space without a stable id cannot be the target of any jump, so giving it one is always safe.
    // Found on Matt's real registry: four spaces had none (imported from files that carried none,
    // and never opened since). Opening a space mints one the same way; this just does not wait.
    if (!stableId) {
      stableId = uuid();
      if (settings) await db.settings.update('main', { kbStableId: stableId });
      else await db.settings.put({ ...DEFAULT_SETTINGS, kbStableId: stableId });
    }
    return { counts: leapTargetCounts(leaps), stableId };
  } finally {
    db.close();
  }
}

/**
 * Spaces whose leaps need counting: never counted, or written to since the last count. The current
 * space is left out — the Spaces tab counts it from memory.
 */
export function spacesNeedingCount(entries: readonly KbEntry[], currentId: string): KbEntry[] {
  // A space with no stable id is read too: reading it is what gives it one.
  return entries.filter((e) => e.id !== currentId && !e.archiveOf &&
    (e.leapTargets === undefined || !e.stableId || (e.lastModified ?? 0) > (e.leapsCountedAt ?? 0)));
}

export type SpaceReadFailure = { id: string; name: string; reason: string; notOnDevice: boolean };

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/** Count and record the given spaces, one at a time. A space that cannot be opened is skipped and reported. */
export async function countLeapsInSpaces(
  spaces: readonly KbEntry[],
  onProgress?: (done: number, total: number) => void,
  shouldStop: () => boolean = () => false,
): Promise<{ counted: number; failed: SpaceReadFailure[] }> {
  const failed: SpaceReadFailure[] = [];
  let counted = 0;
  for (const [i, space] of spaces.entries()) {
    if (shouldStop()) break;
    onProgress?.(i, spaces.length);
    try {
      const { counts, stableId } = await countLeapsInSpace(space.id);
      // The space's own settings are the truth; the registry is an index of them.
      if (stableId && getRegistry().find((k) => k.id === space.id)?.stableId !== stableId) registerStableId(space.id, stableId);
      recordLeapTargets(space.id, counts);
      counted++;
    } catch (e) {
      // KEEP THE REASON. The first version dropped it, so "could not be read" was indistinguishable
      // from "never tried" and 17 of Matt's 18 spaces failed with nothing to go on (2026-09-29).
      const notOnDevice = e instanceof SpaceNotOnDevice;
      const reason = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      failed.push({ id: space.id, name: space.name, reason, notOnDevice });
      if (!notOnDevice) console.warn(`[spaces map] could not read "${space.name}" (${space.id}):`, e);
    }
    await pause();
  }
  onProgress?.(spaces.length, spaces.length);
  return { counted, failed };
}
