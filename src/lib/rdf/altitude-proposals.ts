/**
 * Re-orienting a graph's own predicates into the altitude hierarchy.
 *
 * WHY THIS EXISTS, MEASURED. `fact-altitude.ts` classifies by PREDICATE, and its table was built
 * from Reckons' own authored graphs, where it reaches 95.1% coverage. On a graph produced by
 * CAPTURE it reaches 39.6% (personal-notes.ttl, 2026-08-28), with 0% decision and 0% evidence.
 * Everything unclassified defaults to `judgment`, so the depth ladder's middle rungs collapse that
 * graph from 284 nodes to 8 — not because those facts are unimportant, but because nothing has
 * ever said what kind of fact they are. Two usable rungs, then a cliff.
 *
 * The fix is not a cleverer classifier. `review-tree` already settled that: "the fix is predicate
 * discipline in the graph, not a cleverer guess in the classifier." This module is how that
 * discipline gets proposed — one fact per predicate, `<predicate> kpred:altitude "log"`, pending,
 * for a human to accept.
 *
 * ONLY THE OBJECT SHAPE DECIDES HERE, AND THAT IS THE POINT. Whether `kpred:has-property` is a
 * record or a judgment is a question about what the word MEANS, which is judgment over language
 * and belongs to the agent tier or to the user (F74.3). What a script can settle is what the
 * VALUES look like: a predicate whose objects are always ISO timestamps asserts that something
 * happened, whichever word was chosen for it. So this proposes only where the evidence is
 * decisive and DECLINES otherwise, reporting the decline rather than guessing — a proposer that
 * always has an answer just moves the cost from classification to triage.
 *
 * NOTHING HERE WRITES. It returns proposals. Accepting one is a user act, because classifying a
 * predicate changes what an entire graph shows and hides.
 */

import type { Statement } from './types';
import { isLit } from './types';
import { isClassified, isAltitude, type Altitude } from './fact-altitude';

/** The predicate a user-accepted classification is stored under. */
export const ALTITUDE_PREDICATE = 'urn:kbase:predicate/altitude';

/** A proposed classification for one predicate, with the evidence that produced it. */
export type AltitudeProposal = {
  predicate: string;
  altitude: Altitude;
  /** How many facts in this graph use the predicate — the blast radius of accepting. */
  uses: number;
  /** Why, in words a review card can show. */
  reason: string;
  /** Deterministic proposals only. Kept so a future agent tier can be told apart in the queue. */
  tier: 'script';
};

/** A predicate the rules could not settle. Reported, never guessed at. */
export type UnsettledPredicate = {
  predicate: string;
  uses: number;
  /** What the values look like, so a person or a model has something to go on. */
  sample: string[];
};

export type AltitudeSurvey = {
  proposals: AltitudeProposal[];
  unsettled: UnsettledPredicate[];
  /** Predicates the built-in table already covers. Nothing to do for these. */
  alreadyClassified: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;
const NUMERIC = /^-?\d+(\.\d+)?$/;
const PATHLIKE = /^[\w.@-]+(\/[\w.@-]+)+\.\w+$/;
const URL_LIKE = /^https?:\/\//;

/** Long enough that it is prose rather than a value. Matches the category-literal cut-off. */
const PROSE_LENGTH = 40;

/** Every value must agree before a shape counts as decisive. One counter-example is enough. */
function all(values: string[], test: (v: string) => boolean): boolean {
  return values.length > 0 && values.every(test);
}

/**
 * Classify one predicate from the shape of its objects alone.
 *
 * Returns null when the values do not agree on anything — which is a real answer and the common
 * one. Do not add a fallback here: the fallback IS `unsettled`.
 */
export function altitudeFromValues(
  objects: { literal: boolean; value: string }[],
): { altitude: Altitude; reason: string } | null {
  if (objects.length === 0) return null;

  const literals = objects.filter((o) => o.literal).map((o) => o.value.trim());
  const allLiteral = literals.length === objects.length;
  const allIri = literals.length === 0;

  // A timestamp asserts that something happened at a time. There is no claim in it to dispute,
  // whatever the predicate is called.
  if (allLiteral && all(literals, (v) => ISO_DATE.test(v))) {
    return { altitude: 'log', reason: 'every value is a date or timestamp' };
  }

  // A path or URL is a pointer a script can check — the definition of a record.
  if (allLiteral && all(literals, (v) => PATHLIKE.test(v) || URL_LIKE.test(v))) {
    return { altitude: 'record', reason: 'every value is a file path or URL a script can check' };
  }

  // A number is a measurement. Evidence sits above record precisely because a measurement can
  // pull a judgment out from under itself.
  if (allLiteral && all(literals, (v) => NUMERIC.test(v))) {
    return { altitude: 'evidence', reason: 'every value is a number — a measurement' };
  }

  // An entity-to-entity link is structure. Being wrong means a link needs fixing, which is
  // exactly how review-tree defines a record.
  if (allIri) {
    return { altitude: 'record', reason: 'every value is an entity — a structural link' };
  }

  // Prose is somebody's wording, and wording is where verdicts hide. This is the one shape that
  // routes UPWARD, matching the classifier's own fail-upward default: guessing `log` on prose
  // would hide a real judgment, and hiding a decision is the expensive direction to be wrong in.
  if (allLiteral && all(literals, (v) => v.length > PROSE_LENGTH)) {
    return { altitude: 'judgment', reason: 'every value is prose — a verdict may be inside it' };
  }

  return null;
}

/**
 * Survey a graph and propose an altitude for every predicate the built-in table does not cover.
 *
 * `existing` lets the caller pass previously accepted or rejected classifications so a settled
 * predicate is never proposed again — a queue that re-asks a question the user has answered
 * teaches them to stop reading it.
 */
export function surveyAltitudes(
  statements: Statement[],
  options: { alreadyDecided?: ReadonlySet<string>; sampleSize?: number } = {},
): AltitudeSurvey {
  const { alreadyDecided, sampleSize = 3 } = options;

  const byPredicate = new Map<string, Statement[]>();
  let alreadyClassified = 0;
  const classifiedPredicates = new Set<string>();

  for (const st of statements) {
    const p = st.p.value;
    if (isClassified(st)) {
      if (!classifiedPredicates.has(p)) classifiedPredicates.add(p);
      alreadyClassified++;
      continue;
    }
    if (alreadyDecided?.has(p)) continue;
    const list = byPredicate.get(p) ?? [];
    list.push(st);
    byPredicate.set(p, list);
  }

  const proposals: AltitudeProposal[] = [];
  const unsettled: UnsettledPredicate[] = [];

  for (const [predicate, facts] of byPredicate) {
    const objects = facts.map((st) => ({ literal: isLit(st.o), value: st.o.value }));
    const verdict = altitudeFromValues(objects);
    if (verdict) {
      proposals.push({
        predicate,
        altitude: verdict.altitude,
        uses: facts.length,
        reason: verdict.reason,
        tier: 'script',
      });
    } else {
      unsettled.push({
        predicate,
        uses: facts.length,
        sample: objects.slice(0, sampleSize).map((o) => o.value.slice(0, 80)),
      });
    }
  }

  // Most-used first, in both lists: classifying a predicate used 400 times changes what the
  // graph shows far more than one used twice, and the queue should say so by its order.
  proposals.sort((a, b) => b.uses - a.uses);
  unsettled.sort((a, b) => b.uses - a.uses);
  return { proposals, unsettled, alreadyClassified: classifiedPredicates.size };
}

/**
 * Classifications a human has already ACCEPTED, read back out of the graph.
 *
 * Rejected and superseded are skipped: a rejected classification is the user saying this
 * predicate is NOT that, and honouring it would invert their answer.
 */
export function acceptedAltitudes(statements: Statement[]): Map<string, Altitude> {
  const out = new Map<string, Altitude>();
  for (const st of statements) {
    if (st.p.value !== ALTITUDE_PREDICATE) continue;
    if (st.status === 'rejected' || st.status === 'superseded' || st.status === 'pending') continue;
    if (st.s.kind !== 'iri' || !isLit(st.o)) continue;
    const value = st.o.value.trim();
    if (isAltitude(value)) out.set(st.s.value, value);
  }
  return out;
}

/** Predicates that already carry a classification of ANY status — accepted or turned down. */
export function decidedPredicates(statements: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const st of statements) {
    if (st.p.value === ALTITUDE_PREDICATE && st.s.kind === 'iri') out.add(st.s.value);
  }
  return out;
}
