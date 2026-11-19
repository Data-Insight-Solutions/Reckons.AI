---
title: "Local Models"
slug: "local-models"
order: 1003
section: "LLM"
parent: "what-ll-ms-are"
template: doc
status: published
nav: sidebar
excerpt: "Small language models that run on your own machine (via Ollama, or fully in-browser via WebAssembly)."
generated: "docs-kb"
related:
  - "prefer-local"
  - "structured-outputs"
---

# Local Models

Small language models that run on your own machine (via Ollama, or fully in-browser via WebAssembly). They are less capable than frontier cloud models but keep your data private, cost nothing per call, and work offline. Reckons.AI uses them where they score well: chat, diff summaries, and merge analysis can prefer a reachable local model automatically, while harder extraction stays with your chosen backend.

<p class="derived">It has one part below.</p>

ON A FRESH INSTALL, NO MODEL NAME IS STORED AT ALL. Each task — extracting facts, chatting, or code — asks your Ollama which models are installed and picks one that fits the task's role, so a first run works without anyone having pre-named a model. A model you have explicitly chosen is never overridden: the automatic choice fills the gaps, it does not replace your decision. In Settings the choice reads Automatic, next to the model that would actually run, so it is never a mystery which one answered. And if nothing is installed, the app tells you to pull one — for example, ollama pull gemma3 — instead of sending a request that would fail with no model to answer it.

## Why it is this way

**Honest Note**

THE ROLE LISTS ARE ORDERED BY JUDGMENT, not by a fresh measurement: they lean on one extraction benchmark from 2026-11-04. Only the extraction and chat roles are reachable by a task today (there is a code list, but no task uses it yet). And gemma3, the model the app suggests you pull, is a recommendation, not something measured on this project's own work.

## In this section

**[Structured Outputs](../llm/structured-outputs)**

Instead of asking a model for free-form text and hoping it is parseable, structured output constrains generation to a fixed schema (specific fields, specific types).

## Related

- [Prefer-Local Routing](../features/prefer-local)
- [Structured Outputs](../llm/structured-outputs)
