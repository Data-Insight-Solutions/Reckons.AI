---
title: "Schema-Constrained Local Extraction"
slug: "schema-constrained-extraction"
order: 1036
section: "Architecture"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Small local models (via Ollama) are unreliable at freeform triple extraction, so the local extraction path constrains the model to a fixed JSON schema (subject/predicate/object/type fields) with a compact prompt rather than the richer freeform prompt used for cloud backends."
generated: "docs-kb"
related:
  - "prefer-local"
---

# Schema-Constrained Local Extraction

*Concept*

Small local models (via Ollama) are unreliable at freeform triple extraction, so the local extraction path constrains the model to a fixed JSON schema (subject/predicate/object/type fields) with a compact prompt rather than the richer freeform prompt used for cloud backends. This trades some extraction nuance for reliability: schema-constrained output parses deterministically even from a 1-4B parameter model, where freeform JSON from the same model frequently fails to parse. Structured output is still treated as ordinary pending proposals — nothing bypasses review.

## Related

**Related**

- [Prefer-Local Routing](../features/prefer-local)
