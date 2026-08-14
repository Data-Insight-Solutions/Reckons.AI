---
title: "Feed an agent the graph, not the repo"
slug: "context-compression-coding-workflow"
order: 10
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "kb_compress selects the relevant subgraph for a question and serializes it compactly, so an agent gets grounded context instead of a directory listing."
generated: "docs-kb"
---

# Feed an agent the graph, not the repo

*Concept*

> **Functional** — built and working, with rough edges still being smoothed.

kb_compress selects the relevant subgraph for a question and serializes it compactly, so an agent gets grounded context instead of a directory listing.

## Details

**Honest Note**

- CORRECTED CLAIM. This was marketed as '60-70% token reduction'. The first test ever written for it FALSIFIED that: the encoding saves roughly 18% against grouped Turtle (what a real .ttl actually looks like). The 60-70% figure conflated the ENCODING with SUBGRAPH SELECTION — and selection is where the real saving lives, because the alternative is pasting whole files. The corrected number is in the roadmap, the architecture graph, and here. We do not get to quietly keep the better number.

## Related

**Part Of**

- [Coding workflow](../coding-workflow/coding-workflow)
