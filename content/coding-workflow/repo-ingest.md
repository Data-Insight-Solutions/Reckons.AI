---
title: "Ingest a repository into a graph"
slug: "repo-ingest"
order: 2
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "Point Reckons.AI at a repository and it builds a Codebase graph: modules, their source files (kpred:has-file), and the relationships between them."
generated: "docs-kb"
---

# Ingest a repository into a graph

*Concept*

> **Production** — built, tested, and in use.

Point Reckons.AI at a repository and it builds a Codebase graph: modules, their source files (kpred:has-file), and the relationships between them. The result is queryable — 'which module owns this file', 'what does this depend on' — instead of grep and hope.

## Details

**Proof**

- Reckons.AI's own codebase graph covers 100% of git-tracked source files (static/reckons-codebase.ttl).

## Related

**Part Of**

- [Coding workflow](../coding-workflow/coding-workflow)
