---
title: "Which model made a change, and why"
slug: "commit-trailers"
order: 115
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "A commit written by an AI agent ends with two lines: Model, naming the exact model that wrote it, and Intent, saying in one sentence what the person asked for."
generated: "docs-kb"
---

# Which model made a change, and why

> **Functional** — built and working, with rough edges still being smoothed.

A commit written by an AI agent ends with two lines: Model, naming the exact model that wrote it, and Intent, saying in one sentence what the person asked for. A blocking check in CI refuses an agent commit without them. GitHub squash messages can retain these fields in the original messages before the final co-author block: the history check accepts that format only when every original section has a complete trailer block and the final model co-authors occur in those sections. Ordinary commits and the commit-msg hook still require one final block. A second check refuses a pull request into dev that carries commits found only on main. Models the app downloads are pinned to an exact version for the same reason: a change should be able to name what made it.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

COMMITS ONLY, SO FAR. Facts written inside the app do not yet record the model and its exact version; that is the next part of this work.
