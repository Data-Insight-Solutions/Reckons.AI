---
title: "Currents Monitor (n8n)"
slug: "n8n-currents-monitor"
order: 1002
section: "Integrations & Tech"
parent: "n8n-cloud-sync"
template: doc
status: published
nav: sidebar
excerpt: "n8n workflow (workflow-id qb9uPZ8GScAmuUOX) extending the Source Monitor pattern for Currents: fetches enabled currents on a 30-minute schedule, respecting each current's own cadence via a due-check against its last-fetched time."
generated: "docs-kb"
related:
  - "n8n-source-monitor"
---

# Currents Monitor (n8n)

*Concept*

n8n workflow (workflow-id qb9uPZ8GScAmuUOX) extending the Source Monitor pattern for Currents: fetches enabled currents on a 30-minute schedule, respecting each current's own cadence via a due-check against its last-fetched time. RSS/Atom currents use the RSS Read node; URL-kind currents fetch-and-hash like Source Monitor. Items are deduplicated per (url, graph) before insert, so re-running the sweep never creates duplicate arrivals. Exposes a register webhook (upsert current definitions) and an items webhook (pull new rows for a graph, optionally since a timestamp) that the app polls to populate pod-view arrivals.

## Related

**Related**

- [Source Monitor (n8n)](../integrations-tech/n8n-source-monitor)
