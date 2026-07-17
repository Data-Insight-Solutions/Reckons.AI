/**
 * Trust scoring (kb:trust-system).
 *
 * Extracted from kb.svelte.ts so the maths can be TESTED. It was previously tangled
 * with Dexie access inside the store, which is why a fairly serious bug survived in a
 * feature marked `production`.
 *
 * THE BUG (fixed here, 2026-07-12): trust events are DELTAS — confirm is +0.05, reject
 * is -0.1 — but the old scorer returned the baseline ONLY when there were zero events,
 * and the bare sum of deltas as soon as any event existed. So the first confirmation
 * DISCARDED the baseline:
 *
 *     a 'review' source at 0.3, after one confirm  ->  0.05   (worse than never touched)
 *     a 'trusted' source at 0.8, after one confirm ->  0.05   (collapse)
 *
 * Confirming a fact made its source LESS trusted, and it took 16 confirmations just to
 * climb back to where it started. The deltas are plainly meant to move the score away
 * from a baseline, not to replace it.
 *
 *     score = baseline + Σ(delta · e^(−λ·ageDays)),  clamped to [0,1]
 *
 * Older evidence counts for less, so a source can recover from a bad patch and cannot
 * coast forever on old approvals.
 */
import type { TrustEvent } from './types';

/** Starting score for a source the user has not yet judged. */
export const BASELINE_TRUSTED = 0.8;
export const BASELINE_REVIEW = 0.3;

/**
 * Decay constant, per day. e^(−0.01·t) → an event is worth ~90% after 10 days,
 * ~70% after a month, ~3% after a year. Recent judgements dominate.
 */
export const TRUST_DECAY_PER_DAY = 0.01;

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/** Baseline for a source, before any user judgement is applied. */
export function baselineTrust(trustLevel?: 'trusted' | 'review'): number {
  return trustLevel === 'trusted' ? BASELINE_TRUSTED : BASELINE_REVIEW;
}

/**
 * Current trust score for a source: its baseline, moved by time-decayed user
 * judgements, clamped to [0,1].
 *
 * Pure — no database, no clock of its own. `now` is injected so decay is testable.
 */
export function computeTrustScore(
  events: Pick<TrustEvent, 'delta' | 'timestamp'>[],
  trustLevel: 'trusted' | 'review' | undefined,
  now: number = Date.now(),
): number {
  const baseline = baselineTrust(trustLevel);
  if (events.length === 0) return baseline;

  let adjustment = 0;
  for (const ev of events) {
    // Guard the clock: an event stamped in the future must not be amplified by a
    // negative exponent (e^(+x) grows without bound). Treat it as brand new.
    const ageDays = Math.max(0, (now - ev.timestamp) / MS_PER_DAY);
    adjustment += ev.delta * Math.exp(-TRUST_DECAY_PER_DAY * ageDays);
  }

  return Math.max(0, Math.min(1, baseline + adjustment));
}
