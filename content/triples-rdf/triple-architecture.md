---
title: "The Semantic Triple"
slug: "triple-architecture"
order: 1019
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

## In this section

### IRI (Identifier)

A globally unique identifier for a resource. IRIs are the names of things in RDF -- like URLs but for any concept, not just web pages. Example: urn:reckons:guide/WhatIsReckonsAI

### Knowledge Graph

A graph-structured database where entities are nodes and relationships are edges. Multiple triples form a graph. The same subject can appear in many triples, creating a web of connected knowledge.

#### Why it is this way

**Note**

Reckons.AI renders your knowledge graph as an interactive 3D force-directed graph.

### Literal Values

A data value in RDF: a string, number, date, or boolean. Literals can have a language tag (@en) or a datatype IRI (^^xsd:integer). Example: '42'^^xsd:integer is a typed literal.

**[Plain Text Portability](../triples-rdf/plain-text-portability)**

Your knowledge graph exports as a .ttl file -- plain text, human-readable, no proprietary format.

### Provenance

Every triple in Reckons.AI carries its source. You always know where a fact came from, how trusted that source is, and when it was added. Metadata about metadata -- this is what makes a graph trustworthy.

**[RDF (Resource Description Framework)](../triples-rdf/rdf)**

A W3C standard for representing knowledge as a graph of linked statements.

### Reification

Making a statement about a statement. In RDF, reification assigns an IRI to a triple so it can be annotated with provenance, confidence, or temporal bounds. Reckons.AI uses reification in its TTL export format.

### Subject - Predicate - Object

Subject: the entity being described (always an IRI). Predicate: the relationship or property (always an IRI). Object: the value or target (an IRI or a literal string/number/date). Example: 'Alice worksAt AcmeCorp'. Example: 'Policy covers water-damage'.

#### What we found

**Example**

In 'Earth orbits Sun', Earth=subject, orbits=predicate, Sun=object.

**[The Review Workflow](../triples-rdf/review-workflow)**

1.

**[Turtle (.ttl) Syntax](../triples-rdf/turtle)**

A compact, human-readable syntax for writing RDF triples.

**[Why a graph, and not a notepad](../triples-rdf/why-not-a-notepad)**

Take one sentence from a real working note: Vantage Suite was dropped at this stage on file format grounds.

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
