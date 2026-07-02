---
title: "Entity Normalisation"
slug: "entity-normalisation"
order: 1008
section: "Features"
parent: "ingest"
template: doc
status: published
nav: sidebar
excerpt: "Post-extraction normalisation that rewrites incoming IRIs to match existing KB entities and predicates using embedding similarity."
generated: "docs-kb"
related:
  - "disambiguation"
---

# Entity Normalisation

*Concept*

Post-extraction normalisation that rewrites incoming IRIs to match existing KB entities and predicates using embedding similarity. Prevents duplicate entities like 'octopus-vulgaris' vs 'common-octopus' from entering the review queue. Two-pass matching: exact label (case-insensitive) then cosine similarity (0.90 entity, 0.88 predicate). Protected standard vocabularies (rdf:, rdfs:, skos:, xsd:) are never remapped.

## Related

**Related**

- [Disambiguation](../features/disambiguation)
