---
title: "Text Chunking"
slug: "text-chunking"
order: 1036
section: "Features"
parent: "ingest"
template: doc
status: published
nav: sidebar
excerpt: "Sliding window chunking for sources exceeding the 12K character extraction limit."
generated: "docs-kb"
---

# Text Chunking

*Feature*

Sliding window chunking for sources exceeding the 12K character extraction limit. Each chunk gets a context header (source title, chunk N of M, parent page). Cross-chunk deduplication merges triples with identical (subject, predicate, object) after slugification. Benefits all source types, not just Confluence.
