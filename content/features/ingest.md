---
title: "Ingest"
slug: "ingest"
order: 1015
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Add knowledge from text, URLs, documents, calendars, iCal feeds, Indico events, or Turtle files."
generated: "docs-kb"
---

# Ingest

Add knowledge from text, URLs, documents, calendars, iCal feeds, Indico events, or Turtle files. An LLM extracts semantic triples from unstructured input. Every extracted triple starts as pending for your review.

<p class="derived">It has 3 parts below, 2 of which are not built yet.</p>

<p class="in-sets">Part of Take it in.</p>

## In this section

**[Confluence Migration](../features/confluence-migration)** — **planned**

Bulk import from Confluence spaces.

**[Entity Normalization](../features/entity-normalization)**

Post-extraction normalization that rewrites incoming IRIs to match existing graph entities and predicates using embedding similarity.

### Text Chunking — **planned**

Sliding window chunking for sources exceeding the 12K character extraction limit. Each chunk gets a context header (source title, chunk N of M, parent page). Cross-chunk deduplication merges triples with identical (subject, predicate, object) after slugification. Benefits all source types, not just Confluence.
