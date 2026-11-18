/**
 * Deciding one contradiction in place (F264.3): the pair and the person's choice in, the changes to
 * apply out. Pure; the caller applies it through the store (setStatuses, updateStatement).
 *
 *  - keep-mine:  what is held stays confirmed, the incoming one is rejected.
 *  - take-new:   the incoming one is taken and every held one it opposes is marked superseded, so it
 *                stays readable with its source. This is the same change as 'replace' in the review
 *                queue (resolveConflict in diff.ts), reused rather than written a second time.
 *  - keep-both:  both stand. The pair is marked as a known disagreement, so it reads as seen, not resolved.
 */
import { resolveConflict } from './diff';
import type { Statement } from './types';

export type ContradictionChoice = 'keep-mine' | 'take-new' | 'keep-both';

export type Decision = {
  statuses: { id: string; status: 'superseded' | 'refined' | 'confirmed' | 'rejected' }[];
  /** Statements that get a knownDisagreement mark, and which ids each one disagrees with. */
  marks: { id: string; disagreesWith: string[] }[];
};

export function decideContradiction(pair: { incoming: Statement; held: Statement[] }, choice: ContradictionChoice): Decision {
  const entry = { incoming: pair.incoming, existing: pair.held };
  if (choice === 'keep-mine') return { statuses: resolveConflict(entry, 'reject'), marks: [] };
  if (choice === 'take-new') return { statuses: resolveConflict(entry, 'replace'), marks: [] };
  return {
    statuses: resolveConflict(entry, 'keep-both'),
    marks: [
      { id: pair.incoming.id, disagreesWith: pair.held.map((h) => h.id) },
      ...pair.held.map((h) => ({ id: h.id, disagreesWith: [pair.incoming.id] }))
    ]
  };
}

/** Held statements that carry a recorded disagreement and are still standing, paired with who they disagree with. */
export function knownDisagreements(all: Statement[]): { a: Statement; b: Statement }[] {
  const byId = new Map(all.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const out: { a: Statement; b: Statement }[] = [];
  for (const s of all) {
    for (const otherId of s.knownDisagreement ?? []) {
      const o = byId.get(otherId);
      const key = [s.id, otherId].sort().join('|');
      if (!o || seen.has(key)) continue;
      const standing = (x: Statement) => x.status === 'confirmed' || x.status === 'refined';
      if (!standing(s) || !standing(o)) continue;
      seen.add(key);
      out.push({ a: o, b: s });
    }
  }
  return out;
}
