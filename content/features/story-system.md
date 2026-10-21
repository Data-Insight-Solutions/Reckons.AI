---
title: "Story System"
slug: "story-system"
order: 1036
section: "Features"
parent: "shelly"
template: doc
status: published
nav: sidebar
excerpt: "Guided walkthroughs defined as triples using the story: vocabulary."
generated: "docs-kb"
---

# Story System

> **Production** — built, tested, and in use.

Guided walkthroughs defined as triples using the story: vocabulary. Steps can highlight entities, trigger prompts, and pose questions. Playback with countdown timer and TTS. Shareable via .ttl files. The Generated assets example also offers an interactive Create an asset with Shelly story: describe an image, wait for local generation, then choose video, Gaussian splat or another image. The story waits for your choices and checked results instead of auto-advancing. Previously imported Generated assets examples get the same story entry.

<p class="derived">This is built, working, and in daily use here. It has 3 parts below, 1 of which is not built yet.</p>

- Local generation is optional. Start npm run gen:serve -- --workspace=/path/to/private-workspace on the machine with the tools installed by scripts/content/gen-setup.sh, then connect that same folder in the story (desktop Chrome or Edge). The runner advertises installed image, video and splat tools; missing tools are shown as unavailable. A browser without workspace folder access cannot dispatch these jobs. No model downloads or jobs start merely from opening a story.
- Requests and receipts live in .reckons-generation inside the private workspace. Each job has a stable ID; reopening the story resumes it. Generation writes new assets, never overwrites an example, and adds checked outputs as pending facts with prompt, model, seed, license, time and source-image links. The browser verifies file hashes before attachment. Cancelling prevents attachment; failed images cannot feed derivations. Done for now exits the story, and an active job continues when the panel closes. General free-form chat dispatch and arbitrary derivation tools are not implemented.

## In this section

**[Agent setup and installation permissions](../features/agent-setup)**

An external coding or automation agent can help install generation tools, plugins, or an optional integration when you give it the appropriate terminal or SSH access.

**[Generation tools and setup](../features/generation-setup)**

The Generated assets story works in two layers.

**[Three.js examples on nodes](../features/threejs-examples)** — **in-progress**

Attach an interactive example from [the Three.js gallery](https://threejs.org/examples/) to a node.
