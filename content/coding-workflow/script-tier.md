---
title: "The script tier — checks that cannot hallucinate"
slug: "script-tier"
order: 95
section: "Coding Workflow"
parent: "work-tiering"
template: doc
status: published
nav: sidebar
excerpt: "Deterministic checks that run on every push and cost nothing: graph invariants (dead file links, invalid statuses, duplicate IDs, dangling dependencies); evidence for status claims (a feature marked shipped must link a test or declare that it has none — you may ship untested code, but not silently); prompt/safety-preamble drift; production-build verification; and a license gate on every third-party dependency we study."
generated: "docs-kb"
---

# The script tier — checks that cannot hallucinate

> **Functional** — built and working, with rough edges still being smoothed.

Deterministic checks that run on every push and cost nothing: graph invariants (dead file links, invalid statuses, duplicate IDs, dangling dependencies); evidence for status claims (a feature marked shipped must link a test or declare that it has none — you may ship untested code, but not silently); prompt/safety-preamble drift; production-build verification; and a license gate on every third-party dependency we study.

<p class="derived">This is built and working.</p>

## What we found

**Proof**

scripts/offline/*.ts, run by npm run offline:script-tier and by CI. ~40 seconds, zero tokens.

**Example**

A real catch: the production-build guard found that a stray NODE_ENV=development made `vite build` emit a DEV build — which meant the deploy-gate smoke test had been guarding an artifact that could not exhibit the bug it was written to catch.
