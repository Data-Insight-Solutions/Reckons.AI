---
title: "MCP Workspace"
slug: "mcp-workspace"
order: 1025
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI uses its own MCP server to track product state."
generated: "docs-kb"
---

# MCP Workspace

> **Production** — built, tested, and in use.

Reckons.AI uses its own MCP server to track product state. Three internal graphs (Roadmap, Production, Features) are symlinked from static/*.ttl into mcp-workspace/kbs/. Claude Code queries these graphs before planning work. Edit a TTL file and the MCP server auto-reloads. Setup: bash scripts/setup-mcp-workspace.sh.

<p class="derived">This is built, working, and in daily use here. It has 2 parts below.</p>

## In this section

**[Git Analysis](../features/git-analysis-features)**

Git-aware MCP tools for agent plan alignment.

**[Local jobs through MCP](../features/local-jobs-mcp)**

Long-running work (an e2e suite, a benchmark, a research or batch-analysis run) belongs on the local job queue, not inline on a cloud model.
