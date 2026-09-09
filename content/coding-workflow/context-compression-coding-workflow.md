---
title: "Feed an agent the graph, not the repo"
slug: "context-compression-coding-workflow"
order: 99
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "kb_compress selects the relevant subgraph for a question and serializes it compactly, so an agent gets grounded context instead of a directory listing."
generated: "docs-kb"
---

# Feed an agent the graph, not the repo

> **Functional** — built and working, with rough edges still being smoothed.

kb_compress selects the relevant subgraph for a question and serializes it compactly, so an agent gets grounded context instead of a directory listing.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

CORRECTED CLAIM. This was marketed as '60-70% token reduction'. The first test ever written for it FALSIFIED that: the encoding saves roughly 18% against grouped Turtle (what a real .ttl actually looks like). The 60-70% figure conflated the ENCODING with SUBGRAPH SELECTION — and selection is where the real saving lives, because the alternative is pasting whole files. The corrected number is in the roadmap, the architecture graph, and here. We do not get to quietly keep the better number.
