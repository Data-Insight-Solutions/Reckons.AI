/**
 * Trust scoring (kb:trust-system).
 *
 * This feature was marked `production` and had NO tests. The first one written for it
 * found a serious bug: confirming a fact made its source LESS trusted. See trust.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  computeTrustScore,
  baselineTrust,
  BASELINE_REVIEW,
  BASELINE_TRUSTED,
  TRUST_DECAY_PER_DAY,
} from '../trust';

const DAY = 1000 * 60 * 60 * 24;
const NOW = 1_800_000_000_000;

/** The deltas the app actually emits (see kb.svelte.ts). */
const CONFIRM = 0.05;
const REJECT = -0.1;

const ev = (delta: number, daysAgo = 0) => ({ delta, timestamp: NOW - daysAgo * DAY });

describe('baselineTrust', () => {
  it('starts trusted sources high and unreviewed ones low', () => {
    expect(baselineTrust('trusted')).toBe(BASELINE_TRUSTED);
    expect(baselineTrust('review')).toBe(BASELINE_REVIEW);
    expect(baselineTrust(undefined)).toBe(BASELINE_REVIEW); // unknown ⇒ cautious
  });
});

describe('computeTrustScore', () => {
  it('returns the baseline when the user has judged nothing', () => {
    expect(computeTrustScore([], 'review', NOW)).toBe(BASELINE_REVIEW);
    expect(computeTrustScore([], 'trusted', NOW)).toBe(BASELINE_TRUSTED);
  });

  // ── THE BUG ────────────────────────────────────────────────────────────────
  //
  // The old scorer returned the baseline ONLY when there were zero events, and the
  // bare SUM OF DELTAS as soon as any event existed — so the first confirmation
  // discarded the baseline entirely. A source at 0.3 fell to 0.05 for the crime of
  // being confirmed, and a 'trusted' source at 0.8 collapsed to the same 0.05.
  //
  // These are the tests that would have caught it.

  it('CONFIRMING a fact RAISES trust — it must never lower it', () => {
    const before = computeTrustScore([], 'review', NOW);
    const after = computeTrustScore([ev(CONFIRM)], 'review', NOW);

    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(BASELINE_REVIEW + CONFIRM, 5); // 0.35, not 0.05
  });

  it('a trusted source is not demolished by its first confirmation', () => {
    const after = computeTrustScore([ev(CONFIRM)], 'trusted', NOW);
    expect(after).toBeCloseTo(BASELINE_TRUSTED + CONFIRM, 5); // 0.85
    expect(after).toBeGreaterThan(BASELINE_REVIEW);           // and nowhere near 0.05
  });

  it('REJECTING a fact lowers trust, from the baseline', () => {
    const after = computeTrustScore([ev(REJECT)], 'review', NOW);
    expect(after).toBeCloseTo(BASELINE_REVIEW + REJECT, 5); // 0.2
    expect(after).toBeLessThan(BASELINE_REVIEW);
  });

  it('a reject outweighs a confirm (0.1 down vs 0.05 up)', () => {
    const mixed = computeTrustScore([ev(CONFIRM), ev(REJECT)], 'review', NOW);
    expect(mixed).toBeLessThan(BASELINE_REVIEW);
    expect(mixed).toBeCloseTo(BASELINE_REVIEW + CONFIRM + REJECT, 5); // 0.25
  });

  it('accumulates repeated judgements', () => {
    const events = Array.from({ length: 4 }, () => ev(CONFIRM));
    expect(computeTrustScore(events, 'review', NOW)).toBeCloseTo(BASELINE_REVIEW + 4 * CONFIRM, 5);
  });

  // ── Decay ──────────────────────────────────────────────────────────────────

  it('old judgements count for less than fresh ones', () => {
    const fresh = computeTrustScore([ev(CONFIRM, 0)], 'review', NOW);
    const stale = computeTrustScore([ev(CONFIRM, 365)], 'review', NOW);

    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThan(BASELINE_REVIEW); // still positive, just faint
  });

  it('applies exponential decay at the documented rate', () => {
    const daysAgo = 100;
    const expected = BASELINE_REVIEW + CONFIRM * Math.exp(-TRUST_DECAY_PER_DAY * daysAgo);
    expect(computeTrustScore([ev(CONFIRM, daysAgo)], 'review', NOW)).toBeCloseTo(expected, 6);
  });

  it('lets a source recover: old rejections fade, recent confirmations do not', () => {
    const badPast = computeTrustScore([ev(REJECT, 400), ev(REJECT, 380)], 'review', NOW);
    const redeemed = computeTrustScore(
      [ev(REJECT, 400), ev(REJECT, 380), ev(CONFIRM, 1), ev(CONFIRM, 0)],
      'review',
      NOW,
    );
    expect(redeemed).toBeGreaterThan(badPast);
  });

  // ── Bounds ─────────────────────────────────────────────────────────────────

  it('clamps to [0,1] however lopsided the history', () => {
    const allGood = Array.from({ length: 100 }, () => ev(CONFIRM));
    const allBad = Array.from({ length: 100 }, () => ev(REJECT));

    expect(computeTrustScore(allGood, 'trusted', NOW)).toBe(1);
    expect(computeTrustScore(allBad, 'review', NOW)).toBe(0);
  });

  it('does not amplify an event stamped in the future', () => {
    // e^(−λ·negative) grows without bound, so a bad clock could otherwise mint trust.
    const future = computeTrustScore([{ delta: CONFIRM, timestamp: NOW + 1000 * DAY }], 'review', NOW);
    expect(future).toBeCloseTo(BASELINE_REVIEW + CONFIRM, 5);
    expect(future).toBeLessThanOrEqual(1);
  });
});
