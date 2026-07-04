---
title: "Sliding Window Chunking"
slug: "conf-sliding-window"
order: 1038
section: "Architecture"
parent: "mig-confluence-design"
template: doc
status: published
nav: sidebar
excerpt: "Confluence pages often exceed the 12K char extraction limit."
generated: "docs-kb"
---

# Sliding Window Chunking

*Concept*

Confluence pages often exceed the 12K char extraction limit. Sliding window with overlap: CHUNK_SIZE 10,000 chars (safe for all model context windows), CHUNK_OVERLAP 2,000 chars (catches facts split across boundaries). Cross-chunk deduplication by exact match on (subject, predicate, object) after slugification. Each chunk gets a context header: source title, page N of M, chunk N of M, parent page, labels.
