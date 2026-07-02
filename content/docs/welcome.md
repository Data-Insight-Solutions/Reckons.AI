---
title: "Welcome"
slug: "welcome"
order: 1
section: "Docs"
template: doc
status: published
nav: sidebar
excerpt: "Your first graph-authored page — pages are nodes in the Reckons.AI graph."
---

# Welcome

This page is a **WebPage node** in the Reckons.AI graph. Its title, slug, order,
section, template, and status live as triples; this markdown body is the
long-form content.

The graph is the source of truth — this file is generated from it, and edits made
here in the CMS are proposed back into the graph.

## How pages connect

- **Order & section** set where a page sits in the navigation.
- **Parent** (`skos:broader`) builds the site tree.
- **Related** links (`skos:related`) surface as “related pages”.

Add or edit pages in the graph, publish, and the site rebuilds.
