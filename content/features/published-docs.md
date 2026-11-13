---
title: "Published Graph Site"
slug: "published-docs"
order: 1042
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Any graph can publish itself as a browsable website."
generated: "docs-kb"
---

# Published Graph Site

> **In progress** — actively being built. Parts of what follows may not work yet.

Any graph can publish itself as a browsable website. Entities typed as a web page export to markdown with frontmatter (title, section, order, excerpt) via the graph's own structure: the parent-child links decide the section a page sits in, and the ordering facts decide the sequence pages read in. The generated site is served at /docs. The graph stays the source of truth: generated pages are regenerated from the graph, and hand-edits to them are overwritten by the next regeneration by design. A Git-backed admin UI edits non-generated content (like release posts); a drift check flags generated pages that no longer match their graph.

<p class="derived">This is being built now. It has 2 parts below.</p>

<p class="in-sets">Part of Ask it things.</p>

## In this section

**[Build a website from your notes](../features/site-builder)**

A website kept as a folder of plain text pages can be built into ordinary web pages with one command: npm run site:build -- --site=&lt;site folder&gt; --out=&lt;output folder&gt;.

### Release Notes

Versioned release posts (starting with v0.1.0) authored as graph facts and published through the docs site, using the same web-page model as the rest of /docs.

## Related

- [Published Graph Site](../features/published-docs)
