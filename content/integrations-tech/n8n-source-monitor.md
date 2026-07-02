---
title: "Source Monitor (n8n)"
slug: "n8n-source-monitor"
order: 1021
section: "Integrations & Tech"
parent: "n8n-cloud-sync"
template: doc
status: published
nav: sidebar
excerpt: "n8n workflow CvbUNSZkZVf4hJFG running on a 6-hour schedule trigger."
generated: "docs-kb"
---

# Source Monitor (n8n)

*Concept*

n8n workflow CvbUNSZkZVf4hJFG running on a 6-hour schedule trigger. Reads watched URLs from reckons_watched_urls data table, fetches each URL, computes SHA-256 content hash, compares against stored hash. Changed URLs produce pending notes written to reckons_pending_notes data table with subject (URN from URL), predicate (source-content-changed), object (byte count and new hash), and review note. Add URLs to watch via POST /webhook/reckons-watch-url with JSON body containing url and kb_name. Pending notes surface via the Sync Hub GET /webhook/reckons-kb-pending endpoint.
