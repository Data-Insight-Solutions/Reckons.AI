---
title: "One session, five features not rebuilt"
slug: "case-study-one-session"
order: 14
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "Five requests arrived across a single session on 2026-07-19, each framed as new work — and every one of them had already been decided months earlier."
generated: "docs-kb"
---

# One session, five features not rebuilt

*Concept*

> **Functional** — built and working, with rough edges still being smoothed.

Five requests arrived across a single session on 2026-07-19, each framed as new work — and every one of them had already been decided months earlier. The agent had no memory of those sessions; the graph did: (1) 'summarize a node and its relations' was the unbuilt remainder of F65 entity sets, F96 quick graph settings and the graph-legibility condensation idea; (2) 'group review triples and accept a set' was loop-job-grouping, which already specified batch accept with outlier highlighting — only the topical-relevance axis was genuinely new; (3) 'graphs need HNSW-style jumps to sub-graphs' met hierarchy-nav (layers within a graph) and KBLeap (jumps between graphs), narrowing the work to the one missing middle rung; (4) 'find the most relevant graph for this ingest' met routeQuestion(), already built and tested, needing only a generalized input; (5) the AI-council merge met loop-subagent-graphs, which had already established that a sub-agent returns a graph and that merging graphs is the product.

## Details

**Example**

- The mechanism was two calls, repeated: kb_search to find the name, kb_get_entity to read the ruling. Search returns fragments; the decisive text — a corrected measurement, a principle that forbids an approach — only appears on the full entity. Twenty MCP calls across the session. No conversation history from prior sessions was read, and none was available.

**Honest Note**

- Those token figures are CITED ESTIMATES of builds that did not happen, not measurements — unfalsifiable by construction, which is exactly why each entry names its entity so the reasoning can be checked even when the number cannot. One session is also not a rate: this day was unusually feature-dense. And the division of labour was sharp — the graph supplied the PLAN (what was decided, planned, or forbidden) while grep and file reading supplied the CODE. The graph could say F65 already specified set-grouping; it could not say that buildFocusAnchors() computes a hop map and throws it away.

**Proof**

- Five entries in reckons-workspace/graph-economics.jsonl, each naming the entity that prevented the duplicate. Estimated at ~93K tokens against ~171.5K of total graph maintenance cost since May — so roughly half the graph's lifetime build cost was recouped in one afternoon of avoided duplication.

## Related

**Part Of**

- [The saving is not compression — it is the feature you did not build twice](../coding-workflow/avoided-rework)
