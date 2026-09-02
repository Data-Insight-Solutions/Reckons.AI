/**
 * Which facts a human never needs to be asked about.
 *
 * Matt, 2026-08-27: "Extracted facts need approvals by humans, its semantically risky to not. The
 * log level facts that are verified by system details are not necessarily disputed, automatically
 * trust verifiable facts... the fact Orange Logic is an Enterprise DAM could be extracted and
 * would need verification. The provenance of that fact does not need human verification."
 *
 * TWO INDEPENDENT REASONS A FACT IS NOT WORTH ASKING ABOUT, and they compose with OR:
 *
 *   1. IT HAS NO REVIEWABLE CONTENT (altitude `log`). A dictated sentence stamped with the time
 *      it was said asserts only that somebody said something, and the person being asked is the
 *      person who said it. F139 already says queueing one is "not inefficient, it is incoherent".
 *   2. A MACHINE SETTLES IT (verifiability gate `machine`). Asking a human to confirm what a
 *      check can decide is asking them to guess at something already knowable — and their answer
 *      carries less authority than the check.
 *
 * WHAT THIS DELIBERATELY DOES NOT COVER. Everything a model READ OUT of a note stays pending, at
 * every altitude. "Orange Logic is an enterprise DAM" is a claim about the world made by a
 * language model from a possibly-misheard transcript, and its being mundane is not evidence that
 * it is true. The saving here is confined to facts the SYSTEM asserts about its own operation:
 * that a note was captured, when it was extracted, and which sentence a triple came from.
 *
 * SCOPED TO THE CAPTURE PATH ON PURPOSE. This is not applied to every pending import. Agent
 * proposals into a roadmap can be log-shaped and still deserve a human, because the risk there is
 * not the fact's altitude but the proposer's reliability. Widening this is a decision to take
 * deliberately, with the queue in front of you — not a default to inherit.
 */

import type { Statement } from './types';
import { altitudeOf, isClassified } from './fact-altitude';
import { gateFor } from './verifiability';

export type TrustDecision = {
  trusted: boolean;
  /** Why, in words a review card can show. Never let recall go unexplained. */
  reason: 'log' | 'machine-settleable' | 'system-asserted' | 'needs-human';
};

/**
 * Predicates the SYSTEM writes about its own operation, listed by name rather than inferred.
 *
 * `kpred:extracted-from` classifies as a `record`, and records are emphatically NOT trustworthy
 * in general — `kpred:relates-to` is a record too, and it is the single most common predicate in
 * the roadmap precisely because a human has to judge each one. So the trust here comes from
 * WHO WROTE IT, not from its altitude: these three are emitted by the capture pipeline itself,
 * are re-derivable by re-running it, and make no claim about the world.
 *
 * An allowlist rather than a rule, deliberately. A rule general enough to admit these would also
 * admit things it should not, and this list is short, auditable, and grows only when someone
 * decides it should.
 */
const SYSTEM_ASSERTED = new Set([
  'urn:kbase:predicate/captured-note',
  'urn:kbase:predicate/extracted-at',
  'urn:kbase:predicate/extracted-from',
]);

/**
 * Should this fact be written already-confirmed rather than queued?
 *
 * The `isClassified` guard on the machine branch is load-bearing: an UNKNOWN predicate defaults
 * to `judgment` in the altitude table, and inferring a machine gate from an unrecognised
 * predicate would auto-confirm exactly the facts we understand least.
 */
export function trustDecision(st: Statement): TrustDecision {
  // A partial fact is an open question by construction; it is never settled by anyone but a human.
  if (st.needsObject) return { trusted: false, reason: 'needs-human' };

  if (SYSTEM_ASSERTED.has(st.p.value)) return { trusted: true, reason: 'system-asserted' };

  if (altitudeOf(st) === 'log') return { trusted: true, reason: 'log' };

  if (isClassified(st) && gateFor(st) === 'machine') {
    return { trusted: true, reason: 'machine-settleable' };
  }

  return { trusted: false, reason: 'needs-human' };
}

/** Convenience for the common call. */
export function shouldAutoTrust(st: Statement): boolean {
  return trustDecision(st).trusted;
}

/**
 * The status a freshly built statement should carry.
 *
 * Kept as its own function so the capture path never hand-writes `'confirmed'`: the reason a fact
 * skips review has to be derivable from the fact, or it becomes a decision buried at a call site.
 */
export function statusForNewFact(st: Statement): Statement['status'] {
  return shouldAutoTrust(st) ? 'confirmed' : 'pending';
}
