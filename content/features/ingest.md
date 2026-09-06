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

*Concept*

Add knowledge from text, URLs, documents, calendars, iCal feeds, Indico events, or Turtle files. An LLM extracts semantic triples from unstructured input. Every extracted triple starts as pending for your review.

## Steps

**[Confluence Migration](../features/confluence-migration)** — **planned**

Bulk import from Confluence spaces.

**[Entity Normalization](../features/entity-normalization)**

Post-extraction normalization that rewrites incoming IRIs to match existing graph entities and predicates using embedding similarity.

**[Text Chunking](../features/text-chunking)** — **planned**

Sliding window chunking for sources exceeding the 12K character extraction limit.
