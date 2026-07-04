---
title: "Currents Settings as Meta Triples"
slug: "currents-meta-triples"
order: 1006
section: "Architecture"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Per-graph currents configuration (allowed entity types, per-current source/cadence/label) lives IN the graph as ordinary statements under the urn:reckons:meta/currents/ namespace, the same pattern used by nav:order for hierarchy."
generated: "docs-kb"
related:
  - "currents"
---

# Currents Settings as Meta Triples

*Concept*

Per-graph currents configuration (allowed entity types, per-current source/cadence/label) lives IN the graph as ordinary statements under the urn:reckons:meta/currents/ namespace, the same pattern used by nav:order for hierarchy. This means settings travel with TTL export/import and are visible to MCP tools without a separate settings store. isMetaPredicate hides the whole namespace from the rendered graph edges so it does not clutter the visualization.

## Related

**Related**

- [Currents](../features/currents)
