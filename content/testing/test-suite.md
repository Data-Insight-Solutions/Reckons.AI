---
title: "Test Suite"
slug: "test-suite"
order: 110
section: "Testing"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI test infrastructure: 336+ unit tests (Vitest + jsdom), Playwright E2E with 6 device profiles, visual regression with pixel analysis + DOM overlap + text presence checks, optional Mistral OCR and Claude Vision tiers."
generated: "docs-kb"
related:
  - "what-is-reckons-ai"
---

# Test Suite

Reckons.AI test infrastructure: 336+ unit tests (Vitest + jsdom), Playwright E2E with 6 device profiles, visual regression with pixel analysis + DOM overlap + text presence checks, optional Mistral OCR and Claude Vision tiers. All tests run locally without API keys.

<p class="derived">It has 3 parts below.</p>

## In this section

**[Reckons.AI Graph Review — Goal & Workflow](../testing/graph-review-story)**

The Reckons.AI Graph Review is an offline, exhaustive audit of the whole app treated as a graph: every button is clicked, every screen is visually checked, and every finding is tied back to the graph for human review.

### Unit Tests

336+ tests via Vitest with jsdom environment. Coverage: RDF serialize/import, temporal conflict detection, semantic diff, merge analysis, content safety (28 tests), embedding, mobile auth. Run: npx vitest run.

#### Detail

**Command**

npx vitest run

**Framework**

vitest

**Test Count**

336

**[Visual Regression Tests](../testing/visual-tests)**

Playwright-based visual regression.

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
