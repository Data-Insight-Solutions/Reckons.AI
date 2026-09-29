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
import { KBaseDB } from './db';
import { getRegistry, recordLeapTargets, registerStableId, type KbEntry } from './kb-registry';
import { leapTargetCounts } from '../rdf/space-graph';
import { LEAP_PRED } from '../rdf/kb-leap';
import type { Statement } from '../rdf/types';

export async function countLeapsInSpace(id: string): Promise<{ counts: Record<string, number>; stableId?: string }> {
  const db = new KBaseDB(id);
  try {
    const leaps = (await db.statements.filter((s: Statement) => s.p.value === LEAP_PRED).toArray()) as Statement[];
    const settings = await db.settings.get('main');
    return { counts: leapTargetCounts(leaps), stableId: settings?.kbStableId || undefined };
  } finally {
    db.close();
  }
}

/**
 * Spaces whose leaps need counting: never counted, or written to since the last count. The current
 * space is left out — the Spaces tab counts it from memory.
 */
export function spacesNeedingCount(entries: readonly KbEntry[], currentId: string): KbEntry[] {
  return entries.filter((e) => e.id !== currentId && !e.archiveOf &&
    (e.leapTargets === undefined || (e.lastModified ?? 0) > (e.leapsCountedAt ?? 0)));
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 30));

/** Count and record the given spaces, one at a time. A space that cannot be opened is skipped and reported. */
export async function countLeapsInSpaces(
  spaces: readonly KbEntry[],
  onProgress?: (done: number, total: number) => void,
  shouldStop: () => boolean = () => false,
): Promise<{ counted: number; failed: string[] }> {
  const failed: string[] = [];
  let counted = 0;
  for (const [i, space] of spaces.entries()) {
    if (shouldStop()) break;
    onProgress?.(i, spaces.length);
    try {
      const { counts, stableId } = await countLeapsInSpace(space.id);
      if (stableId && !getRegistry().find((k) => k.id === space.id)?.stableId) registerStableId(space.id, stableId);
      recordLeapTargets(space.id, counts);
      counted++;
    } catch {
      failed.push(space.name);
    }
    await pause();
  }
  onProgress?.(spaces.length, spaces.length);
  return { counted, failed };
}
