/**
 * A REGRESSION TEST FOR A CHECKER THAT WAS CONFIDENTLY WRONG.
 *
 * published-graph-guard reported 166 phantom violations in the published graph and, on the
 * strength of that, the CI script tier was shipped ADVISORY instead of BLOCKING for a day.
 * The graph was clean the whole time. No test existed to contradict the guard, because the
 * script tier — the tier we trust *because* it cannot hallucinate — had no tests at all.
 *
 * The history miner (scripts/offline/history-lessons.ts) found this class on its first run:
 * 20 of 43 recent fixes shipped with no test, and the offenders were the guards themselves.
 *
 * So these assertions are pointed at the exact mistake, not at the general idea.
 */
import { describe, it, expect } from 'vitest';
import { isTestDebris, isProductVocabulary, TEST_NAMESPACES, PRODUCT_NAMESPACES } from '../namespaces';

describe('isTestDebris', () => {
  it('flags the actual test-harness namespace', () => {
    expect(isTestDebris('urn:reckons:test/VR-Step2')).toBe(true);
  });

  it('DOES NOT flag urn:reckons:story/ — this is the false positive that cost a day', () => {
    // The product's guided-story vocabulary. src/lib/rdf/story.ts; landing page; about page;
    // TurtleChatPanel's step walkthrough; declared in reckons-production.ttl.
    expect(isTestDebris('urn:reckons:story/roadmap-tour')).toBe(false);
    expect(isTestDebris('urn:reckons:story/Step')).toBe(false);
    expect(isTestDebris('urn:reckons:story/order')).toBe(false);
  });

  it('a test SUBJECT typed with a story TYPE is debris by its subject, not its type', () => {
    // The original incident: `urn:reckons:test/VR-Step2  rdf:type  urn:reckons:story/Step`.
    // The harness borrowed the product's vocabulary, as it should. Only the subject is debris.
    expect(isTestDebris('urn:reckons:test/VR-Step2')).toBe(true);
    expect(isTestDebris('urn:reckons:story/Step')).toBe(false);
  });

  it('leaves the rest of the product alone', () => {
    expect(isTestDebris('urn:kbase:concept/reckons-ai')).toBe(false);
    expect(isTestDebris('urn:reckons:nav/order')).toBe(false);
    expect(isTestDebris('urn:reckons:guide/intro')).toBe(false);
  });
});

describe('the two sets must never overlap', () => {
  it('nothing is both product vocabulary and test debris', () => {
    for (const p of PRODUCT_NAMESPACES) {
      expect(isTestDebris(p + 'anything'), `${p} must not be treated as debris`).toBe(false);
    }
    for (const t of TEST_NAMESPACES) {
      expect(isProductVocabulary(t + 'anything'), `${t} must not be treated as product`).toBe(false);
    }
  });
});
