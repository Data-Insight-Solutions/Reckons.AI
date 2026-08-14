---
title: "Gap: Full Context Loading"
slug: "ttl-gap-context-loading"
order: 1013
section: "Architecture"
parent: "ttl-vs-markdown-gaps"
template: doc
status: published
nav: sidebar
excerpt: "Reading a markdown file puts full content in context."
generated: "docs-kb"
---

# Gap: Full Context Loading

*Concept*

Reading a markdown file puts full content in context. MCP kb_search returns BM25 results — good for targeted queries, incomplete for broad understanding. Mitigation: kb_compress gives a budget-capped summary, kb_subgraph gives entity neighborhood, reading the TTL file directly is always possible as fallback.
