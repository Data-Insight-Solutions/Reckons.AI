---
title: "How groups are found when you add something"
slug: "set-in-extraction"
order: 1003
section: "Triples & RDF"
parent: "set-architecture"
template: doc
status: published
nav: sidebar
excerpt: "When you add a note or a document, Reckons.AI looks for groups in what it just read, as a separate step after it has worked out the individual facts."
generated: "docs-kb"
---

# How groups are found when you add something

When you add a note or a document, Reckons.AI looks for groups in what it just read, as a separate step after it has worked out the individual facts. It only proposes a group where your text already put several things under one heading -- it does not guess that a list is a group, and it never adds one on its own. Every proposal waits for you in Review, and it says why it grouped what it did.

## Why it is this way

**Note**

It says what it REFUSED as well as what it found. A grouping step that only reports its successes looks cleverer than it is -- in the benchmark that informed this, the two models with a perfect record for not over-grouping achieved it by never grouping anything at all.
