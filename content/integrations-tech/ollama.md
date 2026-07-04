---
title: "Ollama (Local LLM Offload)"
slug: "ollama"
order: 1020
section: "Integrations & Tech"
parent: "integrations"
template: doc
status: published
nav: sidebar
excerpt: "Local model server used two ways: as an in-app LLM backend (schema-constrained structured extraction, and prefer-local routing for chat/diff-summary/merge-analysis when reachable), and as an opt-in MCP bridge (kb_local_extract, kb_local_summarize, kb_generate_page) gated by OLLAMA_BASE_URL so the MCP server never depends on a local model unless you configure one."
generated: "docs-kb"
related:
  - "mcp-server"
---

# Ollama (Local LLM Offload)

*Tool*

Local model server used two ways: as an in-app LLM backend (schema-constrained structured extraction, and prefer-local routing for chat/diff-summary/merge-analysis when reachable), and as an opt-in MCP bridge (kb_local_extract, kb_local_summarize, kb_generate_page) gated by OLLAMA_BASE_URL so the MCP server never depends on a local model unless you configure one. All Ollama-backed output is proposal-only -- nothing is written to a graph without review.

## Related

**Related**

- [MCP Server](../integrations-tech/mcp-server)
