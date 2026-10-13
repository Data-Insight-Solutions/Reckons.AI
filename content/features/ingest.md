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

> **Production** — built, tested, and in use.

Add knowledge from text, URLs, documents, calendars, iCal feeds, Indico events, or Turtle files. An LLM extracts semantic triples from unstructured input. Every extracted triple starts as pending for your review.

<p class="derived">This is built, working, and in daily use here. It has 4 parts below, 2 of which are not built yet.</p>

<p class="in-sets">Part of Take it in.</p>

## In this section

**[Confluence Migration](../features/confluence-migration)** — **planned**

Bulk import from Confluence spaces.

**[Entity Normalization](../features/entity-normalization)**

Post-extraction normalization that rewrites incoming IRIs to match existing graph entities and predicates using embedding similarity.

**[Text Chunking](../features/text-chunking)** — **scaffolded**

A long document is too big to read in one pass, so Reckons.AI reads it in overlapping pieces of about 12,000 characters.

**[The add menu](../features/add-menu)**

The + button at the top of every page opens a short menu of what you can add.
