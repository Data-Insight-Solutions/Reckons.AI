---
title: "Published Graph Site"
slug: "published-docs"
order: 1026
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Any graph can publish itself as a browsable website."
generated: "docs-kb"
---

# Published Graph Site

Any graph can publish itself as a browsable website. Entities typed as a web page export to markdown with frontmatter (title, section, order, excerpt) via the graph's structure -- skos:broader for parent/child, nav:order and nav:next/nav:prev for sequence. The generated site is served at /docs. The graph stays the source of truth: generated pages are regenerated from the graph, and hand-edits to them are overwritten by the next regeneration by design. A Git-backed admin UI edits non-generated content (like release posts); a drift check flags generated pages that no longer match their graph.

<p class="derived">It has one part below.</p>

<p class="in-sets">Part of Ask it things.</p>

## In this section

### Release Notes

Versioned release posts (starting with v0.1.0) authored as graph facts and published through the docs site, using the same web-page model as the rest of /docs.

## Related

- [Published Graph Site](../features/published-docs)
