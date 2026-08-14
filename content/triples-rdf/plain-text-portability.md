---
title: "Plain Text Portability"
slug: "plain-text-portability"
order: 1008
section: "Triples & RDF"
parent: "triple-architecture"
template: doc
status: published
nav: sidebar
excerpt: "Your knowledge graph exports as a .ttl file -- plain text, human-readable, no proprietary format."
generated: "docs-kb"
---

# Plain Text Portability

*Concept*

Your knowledge graph exports as a .ttl file -- plain text, human-readable, no proprietary format. You can open it in any text editor, diff it with git, email it, or print it. When apps shut down and formats die, your .ttl file will still work. It is the most durable way to store knowledge.

## Details

**Note**

- Any RDF tool (SPARQL endpoints, Protege, PoolParty, Neo4j, Python's rdflib) can read your .ttl file directly.
