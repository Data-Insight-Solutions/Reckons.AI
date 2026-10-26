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

<p class="derived">It has 8 parts below.</p>

## In this section

**[Reckons.AI Graph Review — Goal & Workflow](../testing/graph-review-story)**

The Reckons.AI Graph Review is an offline, exhaustive audit of the whole app treated as a graph: every button is clicked, every screen is visually checked, and every finding is tied back to the graph for human review.

**[Test workflows](../testing/test-workflows)**

A test workflow is one whole task a person does in Reckons.AI, written down as numbered steps and then run, step by step, by an automated test in a real browser.

**[Interactive asset generation story](../testing/generated-asset-story)**

Open Generated assets, choose Create an asset with Shelly, enter a synthetic image prompt, and wait for a checked result before choosing a video or Gaussian splat.

**[Local VLM workflow streams](../testing/vlm-workflow-streams)**

Each stream uses fresh browser storage, synthetic UI inputs and an explicit loopback app origin.

**[Synthetic room reconstruction quality](../testing/synthetic-room-benchmark)**

Render the seeded synthetic room with ROOM_BENCHMARK=1, then train against its exact Blender poses.

**[Three.js example loading and isolation](../testing/three-example-nodes)**

Attach a synthetic official-host WebGL example through node details.

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
