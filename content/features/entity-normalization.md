---
title: "Entity Normalization"
slug: "entity-normalization"
order: 1009
section: "Features"
parent: "ingest"
template: doc
status: published
nav: sidebar
excerpt: "Post-extraction normalization that rewrites incoming IRIs to match existing graph entities and predicates using embedding similarity."
generated: "docs-kb"
related:
  - "what-is-reckons-ai"
---

# Entity Normalization

Post-extraction normalization that rewrites incoming IRIs to match existing graph entities and predicates using embedding similarity. Prevents duplicate entities like 'octopus-vulgaris' vs 'common-octopus' from entering the review queue. Two-pass matching: exact label (case-insensitive) then cosine similarity (0.90 entity, 0.88 predicate). Protected standard vocabularies (rdf:, rdfs:, skos:, xsd:) are never remapped.

<p class="in-sets">Part of Work out the claims.</p>

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
