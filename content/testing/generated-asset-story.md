---
title: "Interactive asset generation story"
slug: "generated-asset-story"
order: 1011
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "Open Generated assets, choose Create an asset with Shelly, enter a synthetic image prompt, and wait for a checked result before choosing a video or Gaussian splat."
generated: "docs-kb"
---

# Interactive asset generation story

Open Generated assets, choose Create an asset with Shelly, enter a synthetic image prompt, and wait for a checked result before choosing a video or Gaussian splat. The browser tests drive an OPFS file-queue fixture using existing checked media; they do not run GPU models. They cover image-to-video-to-splat provenance, reopening and reload without duplicate jobs/assets, failed-image retry, cancellation, corruption refusal, unavailable derivations and a space switch during generation. Protocol and runner unit tests reject command/path injection, inconsistent receipts, cross-space dependencies, stale heartbeats and interrupted-job replay.

## Why it is this way

**Honest Note**

Real generation requires a separate local run with installed tools/models and a private workspace. File checks establish decodability and structural validity, not artistic quality. Browser fixtures are not evidence of a GPU run.

## Detail

**Command**

npx playwright test tests/e2e/generated-assets-story.test.ts --project=desktop-chrome --project=mobile-android

**Tested By**

tests/e2e/generated-assets-story.test.ts

<details class="log-archive"><summary>2 earlier entries</summary>

- src/lib/generation/__tests__/protocol.test.ts
- scripts/content/__tests__/generation-runner.test.ts

</details>
