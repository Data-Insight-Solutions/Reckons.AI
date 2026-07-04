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
related:
  - "release-notes"
---

# Published Graph Site

*Concept*

Any graph can publish itself as a browsable website. Entities typed as a web page export to markdown with frontmatter (title, section, order, excerpt) via the graph's structure -- skos:broader for parent/child, nav:order and nav:next/nav:prev for sequence. The generated site is served at /docs. The graph stays the source of truth: generated pages are regenerated from the graph, and hand-edits to them are overwritten by the next regeneration by design. A Git-backed admin UI edits non-generated content (like release posts); a drift check flags generated pages that no longer match their graph.

## Related

**Related**

- [Release Notes](../features/release-notes)
