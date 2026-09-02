/**
 * What a SHARED-VOCABULARY change does to the whole graph, computed before it is accepted.
 *
 * Matt, 2026-08-28, agreeing the position: shared-vocabulary changes force full revalidation.
 *
 * WHY THIS IS NOT A LOCAL ACCEPT. Classifying a predicate — `<kpred:has-property> kpred:altitude
 * "log"` — looks like one small pending fact in a review queue. It is not. Every fact using that
 * predicate changes altitude at once, which changes what the detail ladder draws, what the review
 * tree ranks, what retention may archive, and which nodes clear the substantive-degree bar for hub
 * status. The graph is different everywhere, and the acceptance that did it was one click on a row
 * that looked like any other.
 *
 * The lesson is borrowed rather than invented: Graphwise's account of incremental SHACL validation
 * for the ERA rail knowledge graph separates a subgraph update and a single-resource change — both
 * cheap and local — from SHARED DATA EVOLUTION in ontologies and thesauri, which forces full
 * revalidation because its impact crosses the whole graph. A predicate classification is that third
 * kind exactly.
 *
 * SO REVALIDATION HERE MEANS: RECOMPUTE OVER EVERYTHING, AND REPORT WHAT MOVED. We have no SHACL
 * engine to re-run, and this is not one. What we have is a derived classification over every fact,
 * so the honest equivalent is to compute the classification twice — as it is, and as it would be —
 * and hand the difference to the person about to approve it.
 *
 * THE DIRECTION MATTERS MORE THAN THE COUNT. `review-tree` already ruled that authority can LIFT
 * altitude and never lower it, because demoting a fact hides it from the queue. A vocabulary change
 * that reclassifies four hundred facts DOWN to record or log removes four hundred things from human
 * view, and that number is reported separately and first. Reclassifying upward is merely noisy;
 * reclassifying downward is how a decision goes missing.
 *
 * SECOND-ORDER EFFECTS ARE INCLUDED, WHICH IS WHY THIS RE-RUNS THE REAL CLASSIFIER RATHER THAN
 * SUBTRACTING. Promoting a predicate to `decision` can make its subject carry an OPEN decision,
 * and `liftedAltitudes` then pulls that subject's OTHER facts up with it. A diff that only counted
 * facts using the changed predicate would miss every one of those.
 */

import type { Statement } from './types';
import { ALTITUDE_RANK, altitudeOf, liftedAltitudes, ALTITUDE_META, type Altitude } from './fact-altitude';

/** A change to a term that many facts share. Today: classifying a predicate. */
export type VocabularyChange = {
  kind: 'predicate-altitude';
  predicate: string;
  to: Altitude;
};

export type AltitudeTransition = {
  from: Altitude;
  to: Altitude;
  count: number;
};

export type RevalidationEffect = {
  change: VocabularyChange;
  /** Facts whose altitude moves — including ones that do not use the changed predicate. */
  factsAffected: number;
  /** Facts using the changed predicate directly. The rest moved by lifting. */
  factsDirect: number;
  transitions: AltitudeTransition[];
  /**
   * Facts that stop being reviewable — they become `record` or `log`.
   *
   * The number to read first. These leave the human's queue, and a person approving a
   * one-line classification is entitled to know that is what they are doing.
   */
  hiddenFromReview: number;
  /** Facts that become reviewable. Noisier, but never dangerous. */
  surfacedForReview: number;
  /** Distinct subjects touched — the "everywhere" in "the graph is different everywhere". */
  entitiesTouched: number;
  /** True when anything at all moves down. Cheap guard for a confirmation step. */
  demotes: boolean;
};

/**
 * Apply a change hypothetically.
 *
 * Returns a COPY. A hand-set `altitude` on a fact wins over a predicate classification — it is the
 * more specific ruling — so those statements are left exactly as they are.
 */
export function applyChange(statements: Statement[], change: VocabularyChange): Statement[] {
  return statements.map((st) =>
    st.p.value === change.predicate && !st.altitude ? { ...st, altitude: change.to } : st,
  );
}

/** Facts the change touches directly, ignoring anything that moves by lifting. */
function directCount(statements: Statement[], change: VocabularyChange): number {
  return statements.filter((st) => st.p.value === change.predicate && !st.altitude).length;
}

/**
 * Recompute the whole graph's classification with and without the change, and report the gap.
 *
 * `liftedAltitudes` is run on BOTH sides, which is what makes the second-order effects show up:
 * a predicate promoted to `decision` can lift every other fact on the same subject, and those
 * facts never mention the changed predicate at all.
 */
export function revalidate(
  statements: Statement[],
  change: VocabularyChange,
): RevalidationEffect {
  const before = liftedAltitudes(statements);
  const after = liftedAltitudes(applyChange(statements, change));

  const counts = new Map<string, AltitudeTransition>();
  const entities = new Set<string>();
  let hiddenFromReview = 0;
  let surfacedForReview = 0;
  let factsAffected = 0;

  for (const st of statements) {
    const from = before.get(st.id) ?? altitudeOf(st);
    const to = after.get(st.id) ?? from;
    if (from === to) continue;

    factsAffected++;
    entities.add(st.s.value);

    const key = `${from}>${to}`;
    const entry = counts.get(key) ?? { from, to, count: 0 };
    entry.count++;
    counts.set(key, entry);

    // "Reviewable" is the classifier's own word for it, not a second opinion invented here.
    if (ALTITUDE_META[from].reviewable && !ALTITUDE_META[to].reviewable) hiddenFromReview++;
    if (!ALTITUDE_META[from].reviewable && ALTITUDE_META[to].reviewable) surfacedForReview++;
  }

  // Biggest movements first, and demotions before promotions at equal size: the reader should
  // meet what is being taken away before what is being added.
  const transitions = [...counts.values()].sort(
    (a, b) =>
      b.count - a.count ||
      (ALTITUDE_RANK[a.to] - ALTITUDE_RANK[a.from]) - (ALTITUDE_RANK[b.to] - ALTITUDE_RANK[b.from]),
  );

  return {
    change,
    factsAffected,
    factsDirect: directCount(statements, change),
    transitions,
    hiddenFromReview,
    surfacedForReview,
    entitiesTouched: entities.size,
    demotes: transitions.some((t) => ALTITUDE_RANK[t.to] < ALTITUDE_RANK[t.from]),
  };
}

/**
 * One line a confirmation step can show.
 *
 * Leads with what is removed from view, because that is the consequence a person is least likely
 * to have predicted from the row they are approving.
 */
export function explainEffect(effect: RevalidationEffect): string {
  if (effect.factsAffected === 0) return 'Changes nothing — no fact in this graph moves.';

  const parts = [
    `${effect.factsAffected} fact${effect.factsAffected === 1 ? '' : 's'} across ` +
      `${effect.entitiesTouched} entit${effect.entitiesTouched === 1 ? 'y' : 'ies'}`,
  ];
  if (effect.hiddenFromReview > 0) {
    parts.unshift(`${effect.hiddenFromReview} leave your review queue`);
  }
  if (effect.surfacedForReview > 0) {
    parts.push(`${effect.surfacedForReview} enter it`);
  }
  const indirect = effect.factsAffected - effect.factsDirect;
  if (indirect > 0) {
    parts.push(`${indirect} of them do not use this predicate at all — they move because a subject's altitude lifts`);
  }
  return `${parts.join(' · ')}.`;
}
