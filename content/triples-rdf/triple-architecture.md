---
title: "The Semantic Triple"
slug: "triple-architecture"
order: 20
section: "Triples & RDF"
template: doc
status: published
nav: sidebar
excerpt: "The fundamental unit of knowledge in RDF: a three-part statement -- subject, predicate, object."
generated: "docs-kb"
related:
  - "what-is-reckons-ai"
---

# The Semantic Triple

The fundamental unit of knowledge in RDF: a three-part statement -- subject, predicate, object. Any fact expressible in human language can be expressed as a triple. Triples connect to form a graph, and graphs reveal relationships that documents hide.

<p class="derived">It has 10 parts below.</p>

## In this section

<details class="accordion"><summary>IRI (Identifier)</summary>

A globally unique identifier for a resource. IRIs are the names of things in RDF -- like URLs but for any concept, not just web pages. Example: urn:reckons:guide/WhatIsReckonsAI

</details>

<details class="accordion"><summary>Knowledge Graph</summary>

A graph-structured database where entities are nodes and relationships are edges. Multiple triples form a graph. The same subject can appear in many triples, creating a web of connected knowledge.

</details>

<details class="accordion"><summary>Literal Values</summary>

A data value in RDF: a string, number, date, or boolean. Literals can have a language tag (@en) or a datatype IRI (^^xsd:integer). Example: '42'^^xsd:integer is a typed literal.

</details>

<details class="accordion"><summary>Plain Text Portability</summary>

Your knowledge graph exports as a .ttl file -- plain text, human-readable, no proprietary format.

[Read more](../triples-rdf/plain-text-portability)

</details>

<details class="accordion"><summary>Provenance</summary>

Every triple in Reckons.AI carries its source. You always know where a fact came from, how trusted that source is, and when it was added. Metadata about metadata -- this is what makes a graph trustworthy.

</details>

<details class="accordion"><summary>RDF (Resource Description Framework)</summary>

A W3C standard for representing knowledge as a graph of linked statements.

[Read more](../triples-rdf/rdf)

</details>

<details class="accordion"><summary>Reification</summary>

Making a statement about a statement. In RDF, reification assigns an IRI to a triple so it can be annotated with provenance, confidence, or temporal bounds. Reckons.AI uses reification in its TTL export format.

</details>

<details class="accordion"><summary>Subject - Predicate - Object</summary>

Subject: the entity being described (always an IRI). Predicate: the relationship or property (always an IRI). Object: the value or target (an IRI or a literal string/number/date). Example: 'Alice worksAt AcmeCorp'. Example: 'Policy covers water-damage'.

</details>

<details class="accordion"><summary>The Review Workflow</summary>

1.

[Read more](../triples-rdf/review-workflow)

</details>

<details class="accordion"><summary>Turtle (.ttl) Syntax</summary>

A compact, human-readable syntax for writing RDF triples.

[Read more](../triples-rdf/turtle)

</details>

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
