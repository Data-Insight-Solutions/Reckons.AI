---
title: "Turtle (.ttl) Syntax"
slug: "turtle"
order: 1020
section: "Triples & RDF"
parent: "triple-architecture"
template: doc
status: published
nav: sidebar
excerpt: "A compact, human-readable syntax for writing RDF triples."
generated: "docs-kb"
---

# Turtle (.ttl) Syntax

*Document*

A compact, human-readable syntax for writing RDF triples. File extension: .ttl. Uses prefix declarations, semicolons to share subjects, commas to share predicates, and periods to end statement groups. This file is itself written in Turtle.

## Steps

**[@prefix Declaration](../triples-rdf/turtle-prefix)**

Declares a short alias for a namespace IRI.

**[Comma (,) -- Same Subject and Predicate](../triples-rdf/turtle-comma)**

In Turtle, a comma separates objects that share the same subject and predicate.

**[Period (.) -- End of Statement Group](../triples-rdf/turtle-period)**

A period terminates a group of triples about the same subject.

**[Semicolon (;) -- Same Subject](../triples-rdf/turtle-semicolon)**

In Turtle, a semicolon separates predicate-object pairs that share the same subject.
