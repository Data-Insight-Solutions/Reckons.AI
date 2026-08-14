---
title: "MCP Server"
slug: "mcp-server"
order: 1011
section: "Integrations & Tech"
parent: "integrations"
template: doc
status: published
nav: sidebar
excerpt: "Standalone Node.js MCP server exposing your graph to AI agents (Claude Desktop, Cursor, Claude Code)."
generated: "docs-kb"
related:
  - "ollama"
  - "workspace-sync"
---

# MCP Server

*Concept*

Standalone Node.js MCP server exposing your graph to AI agents (Claude Desktop, Cursor, Claude Code). 20 tools over JSON-RPC stdio: search and read (kb_search, kb_get_entity, kb_list_entities, kb_stats, kb_subgraph, kb_list_kbs, kb_compress), write proposals (kb_add_note), reasoning (kb_reckoning), source management (kb_list_sources, kb_request_refresh), git-aware alignment (kb_git_status, kb_check_plan, kb_pending, kb_git_diff_triples, kb_alignment_score), and the local Ollama bridge (kb_local_extract, kb_local_summarize, kb_generate_page, kb_entity_markdown). Reads workspace TTL files (kbs/&lt;name&gt;/&lt;name&gt;.ttl), with multi-Graph support via MultiKBReader.

## Related

**Related**

- [Ollama (Local LLM Offload)](../integrations-tech/ollama)
- [Workspace Folder Sync](../integrations-tech/workspace-sync)
