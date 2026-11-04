---
title: "Which checks can stop a merge"
slug: "ci-graph"
order: 114
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "The CI workflow files are the rules GitHub runs; static/reckons-ci.ttl is a graph generated from them by scripts/ci-graph.ts."
generated: "docs-kb"
---

# Which checks can stop a merge

> **Functional** — built and working, with rough edges still being smoothed.

The CI workflow files are the rules GitHub runs; static/reckons-ci.ttl is a graph generated from them by scripts/ci-graph.ts. It answers what a contributor needs to know before relying on a green tick: which checks can stop a merge to main, which only report, what each one runs, and which part of the product each one guards. When it was first generated it found 15 checks: 8 can stop a merge to main, and 7 only advise, among them the safety attestation, the dependency audits and the release-notes check.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

THE GRAPH ITSELF ONLY ADVISES. A stale CI graph is fixed by running the script again, so its own check reports rather than blocks. Only main has merge rules; dev and staging have none yet.
