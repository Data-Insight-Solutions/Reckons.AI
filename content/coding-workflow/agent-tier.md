---
title: "The local agent tier — a first pass that never touches your source"
slug: "agent-tier"
order: 7
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "A local model (via Ollama, on your own hardware) reviews a diff, drafts a missing description, or reads for staleness — always inside a scripted harness: ground it in the graph, constrain the prompt, validate the output, emit a PROPOSAL."
generated: "docs-kb"
---

# The local agent tier — a first pass that never touches your source

*Concept*

> **Functional** — built and working, with rough edges still being smoothed.

A local model (via Ollama, on your own hardware) reviews a diff, drafts a missing description, or reads for staleness — always inside a scripted harness: ground it in the graph, constrain the prompt, validate the output, emit a PROPOSAL. It writes to the review queue. It never writes to source, and it never writes to the graph.

## Details

**Honest Note**

- The harness must fail LOUDLY. Ours did not, once: a cold 18GB model load failed, and the review reported a clean run having reviewed nothing. It now refuses to start rather than silently review zero files. An agent tier that quietly does nothing is worse than none, because the queue it feeds looks empty rather than broken.

**Principle**

- Local models hallucinate conventions and mangle serialization. The harness — not the model — is the deliverable.

## Related

**Part Of**

- [Work tiering — stop paying frontier prices for rules](../coding-workflow/work-tiering)
