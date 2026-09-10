---
title: "Turtle (.ttl) Syntax"
slug: "turtle"
order: 1019
section: "Triples & RDF"
parent: "triple-architecture"
template: doc
status: published
nav: sidebar
excerpt: "A compact, human-readable syntax for writing RDF triples."
generated: "docs-kb"
---

# Turtle (.ttl) Syntax

A compact, human-readable syntax for writing RDF triples. File extension: .ttl. Uses prefix declarations, semicolons to share subjects, commas to share predicates, and periods to end statement groups. This file is itself written in Turtle.

<p class="derived">It has 4 parts below.</p>

## In this section

### @prefix Declaration

Declares a short alias for a namespace IRI. Example: @prefix rdf: &lt;http://www.w3.org/1999/02/22-rdf-syntax-ns#&gt; . Prefixes make Turtle readable -- without them every IRI needs full angle-bracket notation.

### Comma (,) -- Same Subject and Predicate

In Turtle, a comma separates objects that share the same subject and predicate. Example: ex:Earth ex:hasOcean ex:Pacific , ex:Atlantic , ex:Indian .

### Period (.) -- End of Statement Group

A period terminates a group of triples about the same subject.

### Semicolon (;) -- Same Subject

In Turtle, a semicolon separates predicate-object pairs that share the same subject. Example: ex:Earth rdf:type ex:Planet ; ex:orbits ex:Sun .
