---
title: "CI/CD graph watch — the plan reviews your PR"
slug: "ci-cd-graph-watch"
order: 93
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "On every push and pull request, CI compares the code changes against the plan in the graph and posts an alignment report as a PR comment: score, discrepancies, drift warnings, and a KB snapshot artifact."
generated: "docs-kb"
---

# CI/CD graph watch — the plan reviews your PR

> **Functional** — built and working, with rough edges still being smoothed.

On every push and pull request, CI compares the code changes against the plan in the graph and posts an alignment report as a PR comment: score, discrepancies, drift warnings, and a KB snapshot artifact. Drift is surfaced where the review already happens, rather than in a dashboard nobody opens.

<p class="derived">This is built and working.</p>

## What we found

**Proof**

.github/workflows/kb-watch.yml + scripts/kb-align.ts. Commands: /check-plan, /pre-review, /post-review.
