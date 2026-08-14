import type { Statement, Term } from './types';
import { termKey, tripleKey } from './types';

/**
 * When new statements come in from a document, we classify each one against
 * the existing KB. The user can then accept, refine, or reject the diff.
 */
export type DiffEntry =
  | { kind: 'new'; incoming: Statement }
  | { kind: 'duplicate'; incoming: Statement; existing: Statement }
  | { kind: 'reinforces'; incoming: Statement; existing: Statement[] } // same (s,p,o), different graph
  | { kind: 'conflicts'; incoming: Statement; existing: Statement[] }   // same (s,p), different o
  | { kind: 'refines'; incoming: Statement; existing: Statement[] }     // existing was rougher
  // Exact triple the user has already settled and dismissed — see indexExisting.
  | { kind: 'returned'; incoming: Statement; existing: Statement[]; priorStatus: 'rejected' | 'superseded' }
  // ── Semantic kinds (populated by semanticEnrichDiff, never by computeDiff) ──
  | { kind: 'near-duplicate'; incoming: Statement; existing: Statement; subjectSimilarity: number }
  | { kind: 'synonym-reinforces'; incoming: Statement; existing: Statement[]; predicateSimilarity: number }
  | { kind: 'antonym-conflicts'; incoming: Statement; existing: Statement[]; note: string };

export type Diff = {
  entries: DiffEntry[];
  summary: {
    new: number;
    duplicate: number;
    reinforces: number;
    conflicts: number;
    refines: number;
    /** Exact triples the user already rejected or superseded, offered again by a re-read. */
    returned: number;
    // Semantic counts — 0 until semanticEnrichDiff runs
    nearDuplicate: number;
    synonymReinforces: number;
    antonymConflicts: number;
  };
};

/**
 * Index existing statements for O(1) lookup by (s,p) pair and (s,p,o) triple.
 *
 * Rejected and superseded statements stay OUT of the active indexes — they must never be
 * reported as a duplicate, conflict or refinement of a live claim — but they are indexed
 * SEPARATELY by exact triple, because dropping them entirely is how a settled decision comes
 * back as news. Re-reading an unchanged source (source refresh, and every currents poll)
 * re-proposes the identical triple, and with no record of the dismissal it classifies as
 * 'new' and lands in the review queue again. On a manual refresh that is an irritation; on a
 * timed poll it is an unbounded loop, because nothing about rejecting it stops the next tick.
 * pending-dedup.ts does not cover this: it collapses duplicates WITHIN the pending queue, and
 * a rejected statement has already left it.
 *
 * Only EXACT (s,p,o) matches are tracked. Rejecting "X hasColour blue" says nothing about
 * "X hasColour red", which is a different claim and may well be the correction the user wants.
 */
function indexExisting(existing: Statement[]) {
  const byTriple = new Map<string, Statement[]>();
  const bySp = new Map<string, Statement[]>();
  const settled = new Map<string, Statement[]>();
  for (const st of existing) {
    const tk = tripleKey(st);
    if (st.status === 'rejected' || st.status === 'superseded') {
      if (!settled.has(tk)) settled.set(tk, []);
      settled.get(tk)!.push(st);
      continue;
    }
    const sp = `${termKey(st.s)}>${termKey(st.p)}`;
    if (!byTriple.has(tk)) byTriple.set(tk, []);
    if (!bySp.has(sp)) bySp.set(sp, []);
    byTriple.get(tk)!.push(st);
    bySp.get(sp)!.push(st);
  }
  return { byTriple, bySp, settled };
}

/**
 * Heuristic refinement detector: a literal object that contains another
 * literal object verbatim as a substring is treated as a refinement.
 * The LLM is also asked to flag refinements explicitly, but this catches
 * the common case where one statement is strictly more specific than another.
 */
function isRefinementOf(incoming: Term, existing: Term): boolean {
  if (incoming.kind !== 'literal' || existing.kind !== 'literal') return false;
  if (incoming.value == null || existing.value == null) return false;
  if (incoming.value === existing.value) return false;
  const a = incoming.value.toLowerCase();
  const b = existing.value.toLowerCase();
  return a.includes(b) && a.length > b.length + 4;
}

export function computeDiff(incoming: Statement[], existing: Statement[]): Diff {
  const { byTriple, bySp, settled } = indexExisting(existing);
  const entries: DiffEntry[] = [];
  const summary = { new: 0, duplicate: 0, reinforces: 0, conflicts: 0, refines: 0, returned: 0, nearDuplicate: 0, synonymReinforces: 0, antonymConflicts: 0 };

  for (const inc of incoming) {
    // Partial facts (F32): the object is an unfilled placeholder, so structural
    // diffing (refines/conflicts against existing objects) is meaningless and
    // would compare a hole. Always surface them as their own 'new' card.
    if (inc.needsObject) {
      entries.push({ kind: 'new', incoming: inc });
      summary.new++;
      continue;
    }
    const tk = tripleKey(inc);
    const sp = `${termKey(inc.s)}>${termKey(inc.p)}`;
    const sameTriple = byTriple.get(tk) ?? [];
    const sameSp = bySp.get(sp) ?? [];

    if (sameTriple.length > 0) {
      // Same (s,p,o). If any share the same graph it's an exact duplicate;
      // otherwise it reinforces an existing claim from a new source.
      const sameGraph = sameTriple.find((s) => termKey(s.g) === termKey(inc.g));
      if (sameGraph) {
        entries.push({ kind: 'duplicate', incoming: inc, existing: sameGraph });
        summary.duplicate++;
      } else {
        entries.push({ kind: 'reinforces', incoming: inc, existing: sameTriple });
        summary.reinforces++;
      }
      continue;
    }

    // Settled-and-dismissed, checked AFTER the live-triple branch above (an active claim is
    // always the more useful comparison) and BEFORE the (s,p) branch below, because an exact
    // match with something the user already dismissed is a more specific signal than a
    // conflict with some other object on the same predicate.
    const wasSettled = settled.get(tk) ?? [];
    if (wasSettled.length > 0) {
      const rejected = wasSettled.filter((s) => s.status === 'rejected');
      entries.push({
        kind: 'returned',
        incoming: inc,
        existing: rejected.length > 0 ? rejected : wasSettled,
        priorStatus: rejected.length > 0 ? 'rejected' : 'superseded'
      });
      summary.returned++;
      continue;
    }

    if (sameSp.length > 0) {
      const refines = sameSp.filter((s) => isRefinementOf(inc.o, s.o));
      const conflicts = sameSp.filter((s) => !isRefinementOf(inc.o, s.o));
      if (refines.length > 0 && conflicts.length === 0) {
        entries.push({ kind: 'refines', incoming: inc, existing: refines });
        summary.refines++;
      } else {
        entries.push({ kind: 'conflicts', incoming: inc, existing: sameSp });
        summary.conflicts++;
      }
      continue;
    }

    entries.push({ kind: 'new', incoming: inc });
    summary.new++;
  }

  return { entries, summary };
}
