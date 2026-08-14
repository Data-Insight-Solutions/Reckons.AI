---
title: "MCP Workspace"
slug: "mcp-workspace"
order: 1018
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI uses its own MCP server to track product state."
generated: "docs-kb"
---

# MCP Workspace

*Concept*

Reckons.AI uses its own MCP server to track product state. Three internal graphs (Roadmap, Production, Features) are symlinked from static/*.ttl into mcp-workspace/kbs/. Claude Code queries these graphs before planning work. Edit a TTL file and the MCP server auto-reloads. Setup: bash scripts/setup-mcp-workspace.sh.
