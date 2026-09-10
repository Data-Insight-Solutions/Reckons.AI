---
title: "RDF (Resource Description Framework)"
slug: "rdf"
order: 1011
section: "Triples & RDF"
parent: "triple-architecture"
template: doc
status: published
nav: sidebar
excerpt: "A W3C standard for representing knowledge as a graph of linked statements."
generated: "docs-kb"
---

# RDF (Resource Description Framework)

A W3C standard for representing knowledge as a graph of linked statements. The foundation of the Semantic Web. RDF itself is abstract -- Turtle, JSON-LD, and RDF/XML are concrete serialization formats.

<p class="derived">It has 6 parts below.</p>

<p class="in-sets">Part of It is plain text you can take away.</p>

## In this section

### JSON-LD

JSON-based serialization for RDF. Embeds linked data in standard JSON using a @context object. Popular for web APIs.

### Linked Data

Tim Berners-Lee's principles for publishing data on the web: use IRIs, use HTTP, provide useful RDF, and link to other datasets.

### PROV-O (Provenance Ontology)

A W3C vocabulary for expressing provenance: who created something, when, and from what sources. Reckons.AI uses prov:wasDerivedFrom to link statements to their source.

### RDF Schema (RDFS)

A vocabulary for describing classes and properties: rdfs:Class, rdfs:subClassOf, rdfs:domain, rdfs:range, rdfs:label, rdfs:comment. Reckons.AI uses rdfs:label for human-readable entity names.

### SKOS (Simple Knowledge Organization System)

A vocabulary for taxonomies and concept hierarchies using skos:broader, skos:narrower, skos:related. This documentation file uses SKOS to organize concepts.

### SPARQL

The query language for RDF graphs. Like SQL for relational databases, but for triple stores. Example: SELECT ?name WHERE {String.fromCharCode(123)} ?person foaf:name ?name {String.fromCharCode(125)}
