---
title: "Source Refresh"
slug: "source-refresh"
order: 1033
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Generic refresh for url, repository, and calendar sources."
generated: "docs-kb"
---

# Source Refresh

Generic refresh for url, repository, and calendar sources. Auto-refresh on open and on interval (configurable). Graph page refresh button. MCP tools: kb_list_sources and kb_request_refresh. Delta comparison shows what changed since last ingest.

## In this section

### Source Monitoring

Watch URLs for content changes. The n8n Source Monitor workflow checks every 6 hours, detects diffs via content hash, and queues pending notes for review. Surfaces via /webhook/reckons-kb-pending endpoint.
