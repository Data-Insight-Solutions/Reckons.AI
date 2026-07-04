---
title: "Pause/Resume Checkpoint"
slug: "conf-pause-resume"
order: 1031
section: "Architecture"
parent: "mig-confluence-design"
template: doc
status: published
nav: sidebar
excerpt: "MigrationCheckpoint stored in localStorage: id, spaceName, totalPages, completedPages (IDs already processed), failedPages (IDs that errored), startedAt, lastCheckpoint."
generated: "docs-kb"
---

# Pause/Resume Checkpoint

*Concept*

MigrationCheckpoint stored in localStorage: id, spaceName, totalPages, completedPages (IDs already processed), failedPages (IDs that errored), startedAt, lastCheckpoint. On page load, detects incomplete migration and offers to resume. Enables overnight imports for large spaces (500+ pages with gemma3:12b takes ~11 hours). Error retry queue with 3 attempts per page.
