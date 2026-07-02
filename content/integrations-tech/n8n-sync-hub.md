---
title: "KB Sync Hub (n8n)"
slug: "n8n-sync-hub"
order: 1008
section: "Integrations & Tech"
parent: "n8n-cloud-sync"
template: doc
status: published
nav: sidebar
excerpt: "n8n workflow gzL6AXn9iWo4GZxN with 4 webhook endpoints: POST /webhook/reckons-kb-upload (accepts JSON with kb_name and ttl_content, SHA-256 content-hash deduplication via upsert into reckons_kb_store data table), GET /webhook/reckons-kb-download?kb=name (serves text/turtle Content-Type), GET /webhook/reckons-kb-status (JSON summary of all stored KBs with names, hashes, and content lengths), GET /webhook/reckons-kb-pending?kb=name (pending notes from source monitors)."
generated: "docs-kb"
---

# KB Sync Hub (n8n)

*Concept*

n8n workflow gzL6AXn9iWo4GZxN with 4 webhook endpoints: POST /webhook/reckons-kb-upload (accepts JSON with kb_name and ttl_content, SHA-256 content-hash deduplication via upsert into reckons_kb_store data table), GET /webhook/reckons-kb-download?kb=name (serves text/turtle Content-Type), GET /webhook/reckons-kb-status (JSON summary of all stored KBs with names, hashes, and content lengths), GET /webhook/reckons-kb-pending?kb=name (pending notes from source monitors). Security: Header Auth credential on each webhook trigger node, pass token via Authorization header.
