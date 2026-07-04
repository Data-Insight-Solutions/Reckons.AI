---
title: "n8n Data Tables"
slug: "n8n-data-tables"
order: 1017
section: "Integrations & Tech"
parent: "n8n-cloud-sync"
template: doc
status: published
nav: sidebar
excerpt: "Three n8n data tables back the cloud sync system."
generated: "docs-kb"
---

# n8n Data Tables

*Concept*

Three n8n data tables back the cloud sync system. reckons_kb_store (ID: JgzUd876HO7ZAHNY) — KB snapshots with columns: kb_name, content_hash (SHA-256), ttl_content (full Turtle text), uploaded_at (timestamp); uses content-hash upsert for deduplication. reckons_watched_urls (ID: JIsQ1QfsKkUAvMCh) — monitored URLs with columns: url, kb_name, content_hash (last known SHA-256), last_checked (timestamp). reckons_pending_notes (ID: irPqWecUHYIppq04) — change notifications with columns: kb_name, subject (URN derived from URL), predicate (e.g. source-content-changed), object_value (description with byte count and new hash), note (review instruction), status (pending/processed).
