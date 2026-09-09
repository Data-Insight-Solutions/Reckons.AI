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

## In this section

### IRI (Identifier)

A globally unique identifier for a resource. IRIs are the names of things in RDF -- like URLs but for any concept, not just web pages. Example: urn:reckons:guide/WhatIsReckonsAI

### Knowledge Graph

A graph-structured database where entities are nodes and relationships are edges. Multiple triples form a graph. The same subject can appear in many triples, creating a web of connected knowledge.

<figure class="scene" role="group" aria-label="A graph is nodes and the named edges between them. Rendered once at build time, so this page still ships no JavaScript."><img src="/scenes/46c4b80ee503153f.png" width="1200" height="480" alt="Nine spheres arranged in a ring, connected by thin lines to the neighbours one and three places along — entities joined by the relations asserted between them." loading="lazy" decoding="async" /><figcaption>A graph is nodes and the named edges between them. Rendered once at build time, so this page still ships no JavaScript.</figcaption></figure>

<figure class="scene scene-live" role="group" aria-label="A graph is nodes and the named edges between them. Rendered once at build time, so this page still ships no JavaScript."><iframe src="/scenes/live/graph-ring" title="Nine spheres arranged in a ring, connected by thin lines to the neighbours one and three places along — entities joined by the relations asserted between them." width="1200" height="600" loading="lazy" style="border:0;max-width:100%;aspect-ratio:1200/600"></iframe><figcaption>A graph is nodes and the named edges between them. Rendered once at build time, so this page still ships no JavaScript.</figcaption></figure>

#### Why it is this way

**Note**

Reckons.AI renders your knowledge graph as an interactive 3D force-directed graph.

#### Detail

**Scene Height**

480

**Scene Width**

1200

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

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
