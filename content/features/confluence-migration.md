---
title: "Confluence Migration"
slug: "confluence-migration"
order: 1002
section: "Features"
parent: "ingest"
template: doc
status: published
nav: sidebar
excerpt: "Bulk import from Confluence spaces."
generated: "docs-kb"
related:
  - "entity-normalization"
---

# Confluence Migration

*Feature*

> **Planned** — on the roadmap, **not yet built**. Described here as intended, not as shipped.

Bulk import from Confluence spaces. Upload an HTML export ZIP, parse the page tree, chunk large pages with sliding window (10K chars, 2K overlap), and extract triples using local models (Ollama recommended). Preserves page hierarchy as skos:broader, converts Confluence labels to entity types, tracks provenance per page. Pause/resume checkpoint for overnight imports of large spaces.

## Related

**Related**

- [Entity Normalization](../features/entity-normalization)
