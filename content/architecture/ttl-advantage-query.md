---
title: "Advantage: MCP Queryability"
slug: "ttl-advantage-query"
order: 1002
section: "Architecture"
parent: "ttl-vs-markdown-gaps"
template: doc
status: published
nav: sidebar
excerpt: "kb_search finds relevant entities across all graphs with a single query."
generated: "docs-kb"
---

# Advantage: MCP Queryability

*Concept*

kb_search finds relevant entities across all graphs with a single query. No need to know which file to read. kb_compress cuts the tokens you feed an LLM, mostly by SELECTING a relevant subgraph rather than handing over the whole graph (the compact encoding itself is worth a further ~18% — measured, not estimated). kb_reckoning gives grounded STP analysis. This is fundamentally better than reading 15 markdown files.
