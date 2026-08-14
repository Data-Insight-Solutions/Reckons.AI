---
title: "Context Compression"
slug: "context-compression-features"
order: 1004
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Condense your context."
generated: "docs-kb"
---

# Context Compression

*Concept*

Condense your context. Keep the meaning. Knowledge graphs are dense by nature — a page of prose becomes a handful of triples. Semantic meaning preserved, tokens reduced. Feed compressed graph directly to AI agents via MCP. Structured triples outperform summaries because no relationships are paraphrased away.

## Details

**Has Param**

- budget (default 2000, max 8000) — approximate token budget
- hops (default 1, max 2) — neighborhood expansion depth
- kb — target a specific knowledge graph
- query (required) — topic to extract context for

**Has Tool**

- kb_compress
