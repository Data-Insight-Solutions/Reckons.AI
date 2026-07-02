---
title: "Import as Source with Update Detection"
slug: "import-as-source"
order: 1007
section: "Use Cases"
parent: "collaborative-knowledge"
template: doc
status: published
nav: sidebar
excerpt: "Treat an imported TTL file as a named source with a sharedBy field and content hash."
generated: "docs-kb"
---

# Import as Source with Update Detection

*Concept*

Treat an imported TTL file as a named source with a sharedBy field and content hash. When the original sharer re-exports, importers see a 'source updated' notification and route through Compare instead of direct merge. The importer accepts or rejects individual changes from the updated TTL, keeping their personal annotations intact.
