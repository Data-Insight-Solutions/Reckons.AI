---
title: "Currents"
slug: "currents"
order: 1006
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Streamed ingest: point a current at an RSS feed, URL, or topic and it brings recurring external content into your graph on a schedule."
generated: "docs-kb"
related:
  - "pod-view"
---

# Currents

*Concept*

Streamed ingest: point a current at an RSS feed, URL, or topic and it brings recurring external content into your graph on a schedule. Items arrive via the n8n Currents Monitor (or a direct in-browser RSS fetch as fallback) and are ranked by affinity to your graph's most-connected entities, with near-duplicates collapsed and content-policy filtering applied. New facts always land as pending — a current never bypasses review. An entity-type gate (set in graph settings) restricts which types a current may CREATE; facts attaching to entities already in the graph always flow through. Configure currents and the type gate from the graph page.

## Related

**Related**

- [Pod View](../features/pod-view)
