---
title: "Multi-Graph Management"
slug: "multi-kb"
order: 1020
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Create, switch, rename, and delete independent knowledge graphs."
generated: "docs-kb"
related:
  - "kb-leap"
---

# Multi-Graph Management

Create, switch, rename, and delete independent knowledge graphs. Each graph has its own IndexedDB store, stable UUID, content fingerprint, and optional accent color. Per-tab graph support via URL ?kb= parameter.

<p class="derived">It has 2 parts below.</p>

<p class="in-sets">Part of Keep it.</p>

## In this section

### Graph Identity

Each graph has a stable UUID (never changes, used for MCP routing and graph Leap) and a content fingerprint (SHA-256 of sorted N-Quads, changes with every edit). Both visible in Settings.

**[Graph Leap](../features/kb-leap)**

Cross-reference entities between graphs.

## Related

- [Graph Leap](../features/kb-leap)
