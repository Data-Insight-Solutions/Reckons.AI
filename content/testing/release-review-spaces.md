---
title: "A review space for each release"
slug: "release-review-spaces"
order: 1000
section: "Testing"
parent: "test-workflows"
template: doc
status: published
nav: sidebar
excerpt: "Each release gets a space of its own for the person who approves it."
generated: "docs-kb"
---

# A review space for each release

Each release gets a space of its own for the person who approves it. It is generated from the roadmap and from the test workflows: the release's test workflows in the order a person would follow them, each step with its screenshot and what the test checks, and every part of the release that has no workflow listed together under one node, No visual test yet, so the gap stays in view. Open it from About, under example data (Review 0.2.6, Review 0.2.7). Select a step, look at its picture, and mark it pass or fail, or add a note, in the node panel.

## Why it is this way

**Honest Note**

MOSTLY GAPS SO FAR. When v0.2.6 closed, 1 of its 15 parts had a test workflow, so Review 0.2.6 is mostly the No visual test yet list. The person's verdicts are kept in their own copy of the space and are not collected anywhere else.

## Detail

**Command**

npx tsx scripts/offline/release-review-space.ts (add --check to fail when a review space is out of date)
