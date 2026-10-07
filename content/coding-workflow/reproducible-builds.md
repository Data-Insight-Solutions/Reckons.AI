---
title: "A fresh checkout that behaves like CI"
slug: "reproducible-builds"
order: 111
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "The goal: clone the repository, install once, and every check, test and build runs the same on your machine as in CI, with nothing downloaded behind your back."
generated: "docs-kb"
---

# A fresh checkout that behaves like CI

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

The goal: clone the repository, install once, and every check, test and build runs the same on your machine as in CI, with nothing downloaded behind your back. That means one pinned package manager and Node version, every tool declared as a dependency, and quality gates that block a merge rather than warn.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

NOT THERE YET. CI already blocks on type checks, unit tests, the build, graph lint and the page-drift check (md-align). Svelte warnings are not yet held at zero, coverage thresholds do not block, and the CLI, extension and cross-browser suites do not all run on every change.
