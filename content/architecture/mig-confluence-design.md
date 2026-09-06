---
title: "Confluence Migration Design"
slug: "mig-confluence-design"
order: 1004
section: "Architecture"
parent: "mig-confluence"
template: doc
status: published
nav: sidebar
excerpt: "Design decisions and implementation details for F26 Confluence Migration."
generated: "docs-kb"
---

# Confluence Migration Design

*Concept*

Design decisions and implementation details for F26 Confluence Migration. Covers the 6-step migration pipeline, sliding window chunking, local model recommendations, pause/resume checkpointing, and page hierarchy preservation.

## Steps

**[6-Step Migration Pipeline](../architecture/conf-migration-pipeline)**

Step 1: Upload ZIP — user selects Confluence HTML export ZIP via confluence tab.

**[Local Model Recommendations](../architecture/conf-local-models)**

Recommended: gemma3:12b via Ollama for migration.

**[Migration Memory Management](../architecture/conf-memory-management)**

For large spaces (500+ pages): write each page's triples to IndexedDB immediately after extraction (already done via addStatements).

**[Page Hierarchy Preservation](../architecture/conf-page-hierarchy)**

Confluence parent-child page relationships mapped to skos:broader triples.

**[Pause/Resume Checkpoint](../architecture/conf-pause-resume)**

MigrationCheckpoint stored in localStorage: id, spaceName, totalPages, completedPages (IDs already processed), failedPages (IDs that errored), startedAt, lastCheckpoint.

**[Sliding Window Chunking](../architecture/conf-sliding-window)**

Confluence pages often exceed the 12K char extraction limit.
