---
title: "Membership overlaps -- it does not file things away"
slug: "set-overlap"
order: 1009
section: "Triples & RDF"
parent: "set-architecture"
template: doc
status: published
nav: sidebar
excerpt: "A thing can belong to as many sets as it really belongs to."
generated: "docs-kb"
---

# Membership overlaps -- it does not file things away

A thing can belong to as many sets as it really belongs to. A vendor can be on the shortlist AND already deployed; a person can be in the project team AND the football team. This is the difference between a set and a folder: a folder makes you choose one home for a thing, and choosing wrongly hides it. Where two sets share members, that shared part is itself worth looking at -- Reckons.AI works it out rather than asking you to maintain a list of related things by hand.

## Why it is this way

**Note**

This turned out to be the hard part for automatic grouping. In a benchmark of four local AI models across five runs each, not one ever put a single thing into two sets -- every model filed each thing in exactly one place. It is the main reason grouping here does not rely on a model.
