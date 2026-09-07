---
title: "n8n Cloud Sync"
slug: "n8n-cloud-sync"
order: 1016
section: "Integrations & Tech"
parent: "integrations"
template: doc
status: published
nav: sidebar
excerpt: "Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS."
generated: "docs-kb"
---

# n8n Cloud Sync

Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS. Two workflows: Graph Sync Hub (workflow gzL6AXn9iWo4GZxN — upload/download/status/pending via webhooks with SHA-256 content-hash deduplication) and Source Monitor (workflow CvbUNSZkZVf4hJFG — watches URLs every 6 hours, detects content changes via hash comparison, queues pending notes). Three data tables: reckons_kb_store (snapshots), reckons_watched_urls (monitored URLs), reckons_pending_notes (change notifications). Security via n8n Header Auth on webhook trigger nodes. No SaaS dependency — your n8n VPS is the cloud backend. Air-gapped operation supported.

## In this section

**[Currents Monitor (n8n)](../integrations-tech/n8n-currents-monitor)**

n8n workflow (workflow-id qb9uPZ8GScAmuUOX) extending the Source Monitor pattern for Currents: fetches enabled currents on a 30-minute schedule, respecting each current's own cadence via a due-check against its last-fetched time.

**[Graph Sync Hub (n8n)](../integrations-tech/n8n-sync-hub)**

n8n workflow gzL6AXn9iWo4GZxN with 4 webhook endpoints: POST /webhook/reckons-kb-upload (accepts JSON with kb_name and ttl_content, SHA-256 content-hash deduplication via upsert into reckons_kb_store data table), GET /webhook/reckons-kb-download?kb=name (serves text/turtle Content-Type), GET /webhook/reckons-kb-status (JSON summary of all stored graphs with names, hashes, and content lengths), GET /webhook/reckons-kb-pending?kb=name (pending notes from source monitors).

**[n8n Data Tables](../integrations-tech/n8n-data-tables)**

Three n8n data tables back the cloud sync system.

**[Source Monitor (n8n)](../integrations-tech/n8n-source-monitor)**

n8n workflow CvbUNSZkZVf4hJFG running on a 6-hour schedule trigger.
