---
title: "6-Step Migration Pipeline"
slug: "conf-migration-pipeline"
order: 1000
section: "Architecture"
parent: "mig-confluence-design"
template: doc
status: published
nav: sidebar
excerpt: "Step 1: Upload ZIP — user selects Confluence HTML export ZIP via confluence tab."
generated: "docs-kb"
---

# 6-Step Migration Pipeline

*Concept*

Step 1: Upload ZIP — user selects Confluence HTML export ZIP via confluence tab. Step 2: Preview and Configure — shows page count, total text, estimated chunks, estimated time, backend/model selector, options (preserve hierarchy, convert labels, include URLs, extract from attachments). Step 3: Extraction Queue — sequential page processing with progress bar, pause/skip/cancel controls. Step 4: Post-Processing — cross-page entity normalisation, hierarchy injection (skos:broader), label-to-type mapping (rdf:type), source provenance. Step 5: Review — all triples enter review queue as pending with confluence-aware filters (by source page, by label, bulk confirm by page, sort by confidence). Step 6: Optional Cloud Refinement — re-extract only rejected/low-confidence triples with Claude, typically &lt;5% of total.
