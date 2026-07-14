/**
 * Which IRIs are test-harness debris, and which are the product's own vocabulary.
 *
 * THIS EXISTS BECAUSE THE DISTINCTION WAS GOT WRONG, and it cost a day.
 *
 * `published-graph-guard.ts` reported 166 "test-harness terms" in the published graph and
 * kept the CI script tier switched from BLOCKING to advisory. The finding was false. It had
 * banned `urn:reckons:story/`, which is the PRODUCT'S guided-story vocabulary
 * (src/lib/rdf/story.ts — the landing page, the about page, TurtleChatPanel's walkthrough).
 *
 * The mistake is visible in the original incident line: `urn:reckons:test/VR-Step2 rdf:type
 * story:Step`. A test SUBJECT wearing a story TYPE. The harness borrowed the product's
 * vocabulary, exactly as it should — and the guard condemned the vocabulary along with the
 * debris.
 *
 * It survived because THE SCRIPT TIER HAD NO TESTS. That tier is trusted precisely because
 * it is deterministic, but determinism buys "the rule fired"; it does not buy "the rule was
 * right". So the rule lives here, on its own, with tests — the cheapest possible correction
 * of the most expensive kind of mistake: a checker that is confidently wrong.
 */

/** Namespaces that belong to the TEST HARNESS, and to nothing else. */
export const TEST_NAMESPACES = ['urn:reckons:test/'] as const;

/**
 * Namespaces that LOOK test-ish but are the product's own, and must never be treated as
 * debris. Kept explicit so the next person to widen TEST_NAMESPACES trips over this first.
 */
export const PRODUCT_NAMESPACES = [
  'urn:reckons:story/', // guided stories/tours — src/lib/rdf/story.ts
  'urn:reckons:nav/', // hierarchical navigation
  'urn:reckons:guide/', // starter guide
] as const;

/** Is this term the residue of a test run, rather than part of the product? */
export function isTestDebris(term: string): boolean {
  return TEST_NAMESPACES.some((ns) => term.startsWith(ns));
}

/** Is this term part of the product's own vocabulary (and therefore NOT debris)? */
export function isProductVocabulary(term: string): boolean {
  return PRODUCT_NAMESPACES.some((ns) => term.startsWith(ns));
}
