---
title: "Page Hierarchy Preservation"
slug: "conf-page-hierarchy"
order: 1028
section: "Architecture"
parent: "mig-confluence-design"
template: doc
status: published
nav: sidebar
excerpt: "Confluence parent-child page relationships mapped to skos:broader triples."
generated: "docs-kb"
---

# Page Hierarchy Preservation

*Concept*

Confluence parent-child page relationships mapped to skos:broader triples. Page tree reconstructed from index.html table of contents links. Labels converted to rdf:type entities. Each page becomes a Source with Confluence metadata (confluencePageId, confluenceSpaceKey, confluenceLabels). Source kind: confluence.
