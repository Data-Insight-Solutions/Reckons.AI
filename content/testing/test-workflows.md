---
title: "Test workflows"
slug: "test-workflows"
order: 112
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "A test workflow is one whole task a person does in Reckons.AI, written down as numbered steps and then run, step by step, by an automated test in a real browser."
generated: "docs-kb"
---

# Test workflows

A test workflow is one whole task a person does in Reckons.AI, written down as numbered steps and then run, step by step, by an automated test in a real browser. Each workflow page shows the steps as a diagram, says in plain words what happens at each step, shows a screenshot of the real app with a box drawn round the control being checked, and states the one thing the test checks at that step.

### Why a page for each

A passing test only says "nothing broke". A workflow page lets a person who has never opened the app see what the test actually does, in the order they would do it, and judge for themselves whether the check at each step is a meaningful one.

### How to read a workflow page

1. **The diagram** is drawn from the step list itself, so it always matches what the test runs.
2. **Each step** has the words for what happens, where it happens, the screenshot, then **What the test checks**.
3. **The pink box** in a screenshot marks the control or area that step is about.

### What is honest about this

Screenshots are taken on synthetic example data, never on anyone's real notes. A step whose screenshot has not been captured yet says so instead of showing a stand-in picture. The test confirms the app responds at every step; it does not judge how good the extracted claims or a reckoning's proposal are, which are measured separately. Each workflow page says which parts are scripted stand-ins for a model.

<p class="derived">It has 4 parts below.</p>

## In this section

**[A review space for each release](../testing/release-review-spaces)**

Each release gets a space of its own for the person who approves it.

**[Add a source, review it, see it in a space, ask for a reckoning](../testing/workflow-readme-path)**

The path the README describes, start to finish: put a short note into Reckons.AI, settle the claims it proposes, find them in your space, and ask for a reckoning that works from what you settled.

**[Build a space from a note, then change it with another](../testing/workflow-build-change)**

Space building and space changing, start to finish: add a note and accept what it says in one go, then add a second note that changes some of it, and decide each change.

**[Make pictures, clips and 3D splats on your own machine, and see them in a space](../testing/workflow-generated-assets)**

Write a prompt, and three local models turn it into a picture, then a short clip and a Gaussian splat (a 3D object drawn as many small soft blobs of color) made from that picture.
