---
title: "Graph Is Source of Truth (Docs Pipeline)"
slug: "graph-is-source-of-truth"
order: 1015
section: "Architecture"
parent: "ttl-first-docs"
template: doc
status: published
nav: sidebar
excerpt: "The docs TTL knowledge graphs (static/*.ttl) are the canonical source for the published /docs site, not the other way around: scripts/docs-pages.ts reads the docs graphs and generates content/*.md, which SvelteKit prerenders."
generated: "docs-kb"
related:
  - "published-docs"
---

# Graph Is Source of Truth (Docs Pipeline)

*Concept*

The docs TTL knowledge graphs (static/*.ttl) are the canonical source for the published /docs site, not the other way around: scripts/docs-pages.ts reads the docs graphs and generates content/*.md, which SvelteKit prerenders. There is deliberately NO markdown-to-TTL back-propagation (decided 2026-07-03): graph edits happen in the app or directly on the TTL files, the Sveltia CMS admin UI is only for non-generated content, and hand-edits to generated pages are overwritten by the next regeneration by design. scripts/md-align.ts (built on the site-import round-trip) flags generated pages that have drifted from their graph, so accidental hand-edits are caught rather than silently absorbed.

## Related

**Related**

- [Published Graph Site](../features/published-docs)
