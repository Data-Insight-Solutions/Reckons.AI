---
title: "The saving is not compression — it is the feature you did not build twice"
slug: "avoided-rework"
order: 13
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "The usual pitch for a knowledge graph in front of a coding agent is token compression: feed a dense subgraph instead of re-reading the repo."
generated: "docs-kb"
---

# The saving is not compression — it is the feature you did not build twice

*Concept*

> **Functional** — built and working, with rough edges still being smoothed.

The usual pitch for a knowledge graph in front of a coding agent is token compression: feed a dense subgraph instead of re-reading the repo. That saving is real but modest. The larger one is structural — an agent that can query what you already decided proposes an EXTENSION to an existing feature instead of a new feature under a slightly different name. A duplicate feature is not a one-off cost: you pay to build it, then pay forever to maintain two things that should have been one, and the second one drifts from the first the first time either is tuned.

## Details

**Honest Note**

- Avoided rework CANNOT be measured automatically — a build that did not happen leaves no trace in git. It is recorded in a hand-written ledger where every entry cites the entity that prevented the duplicate, so the reasoning can be audited even though the token figure is an estimate. An automatic count here would be a fabrication, and a comfortable one, because nobody could check it.

**Measured**

- Measured by scripts/offline/graph-economics.ts, which counts BOTH sides — maintenance churn and tool-schema cost as the debit, compressed context and cited avoided-rework as the credit — and prints a break-even. Counting only the savings is how the earlier 60-70% claim got overstated; that figure was corrected on 2026-07-12 once the format and the subgraph-selection savings were separated.

**Principle**

- A model with no memory of your decisions does not know it is repeating you. It cannot: nothing in its context distinguishes 'this is new' from 'you settled this in April'. The graph is what makes that distinction available, and it has to be QUERIED — an agent that is merely handed a large context still has to notice.

## Related

**Part Of**

- [Coding workflow](../coding-workflow/coding-workflow)
