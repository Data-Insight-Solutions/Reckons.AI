---
title: "Work tiering — stop paying frontier prices for rules"
slug: "work-tiering"
order: 5
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "Every recurring task is routed to the cheapest tier that can do it correctly."
generated: "docs-kb"
---

# Work tiering — stop paying frontier prices for rules

*Concept*

> **In progress** — actively being built. Parts of what follows may not work yet.

Every recurring task is routed to the cheapest tier that can do it correctly. SCRIPT: the answer is checkable by a rule ('does this path exist', 'is this status in the enum') — deterministic code, zero tokens, zero hallucination, runs in CI. LOCAL AGENT: the answer is judgment over language and being wrong is cheap, because the output is a proposal a human gates — a local model inside a scripted harness that grounds it, validates its output, and emits a reviewable proposal. FRONTIER: cross-file architectural reasoning, deciding process, and code that lands.

## Details

**Honest Note**

- IN PROGRESS, and the honest part is which half. The script tier runs in CI on every push, but it is ADVISORY — it reports and queues findings, it does not fail the build (one exception: the production-build guard, which blocks). Making it blocking is gated on cleaning our own published graph, which currently contains test debris. We are not going to describe a gate we do not yet exercise.

**Principle**

- Offloading is not free. A local job that emits 30 findings of which 25 are noise moves cost from generation to TRIAGE rather than removing it. Deterministic checks have zero triage cost because they are right by construction — so grow the script tier before the agent tier.

## Related

**Part Of**

- [Coding workflow](../coding-workflow/coding-workflow)
