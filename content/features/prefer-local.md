---
title: "Prefer-Local Routing"
slug: "prefer-local"
order: 1025
section: "Features"
parent: "llm-backends"
template: doc
status: published
nav: sidebar
excerpt: "Opt-in setting that redirects chat, diff-summary, and merge-analysis to a local Ollama model whenever it is reachable, instead of your chosen cloud backend."
generated: "docs-kb"
---

# Prefer-Local Routing

*Concept*

Opt-in setting that redirects chat, diff-summary, and merge-analysis to a local Ollama model whenever it is reachable, instead of your chosen cloud backend. Falls back to your normal backend chain the moment Ollama is unreachable -- no extraction quality is sacrificed silently. A companion structured-extraction mode uses a compact, schema-constrained prompt so small local models still produce clean facts.
