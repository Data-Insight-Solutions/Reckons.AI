---
title: "n8n Cloud Sync"
slug: "n8n-cloud-sync"
order: 1015
section: "Integrations & Tech"
parent: "integrations"
template: doc
status: published
nav: sidebar
excerpt: "Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS."
generated: "docs-kb"
---

# n8n Cloud Sync

*Concept*

Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS. Two workflows: KB Sync Hub (workflow gzL6AXn9iWo4GZxN — upload/download/status/pending via webhooks with SHA-256 content-hash deduplication) and Source Monitor (workflow CvbUNSZkZVf4hJFG — watches URLs every 6 hours, detects content changes via hash comparison, queues pending notes). Three data tables: reckons_kb_store (snapshots), reckons_watched_urls (monitored URLs), reckons_pending_notes (change notifications). Security via n8n Header Auth on webhook trigger nodes. No SaaS dependency — your n8n VPS is the cloud backend. Air-gapped operation supported.
