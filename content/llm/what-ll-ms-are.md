---
title: "What Language Models Actually Are"
slug: "what-ll-ms-are"
order: 60
section: "LLM"
template: doc
status: published
nav: sidebar
excerpt: "The models people call 'AI' are trained statistical models built with human knowledge at every level."
generated: "docs-kb"
related:
  - "kb-grounded-accuracy"
---

# What Language Models Actually Are

The models people call 'AI' are trained statistical models built with human knowledge at every level. Humans wrote the training data, designed the architecture, labeled the fine-tuning examples, and aligned the outputs. These models predict likely text based on patterns -- they do not think, reason, or understand.

<p class="derived">It has 7 parts below.</p>

## In this section

**[Reckons.AI compared with vector search and RAG](../llm/versus-vector-rag)**

Vector search and Reckons.AI answer different questions, and most of the confusion between them comes from pretending they answer the same one.

### Built on Human Knowledge

Every layer of a language model relies on human work. The training corpus is human-written text. The architecture was designed by human researchers. RLHF alignment uses human judgments. The model's outputs are a reflection of collective human knowledge, filtered through statistical compression.

**[Graph-Grounded Accuracy](../llm/kb-grounded-accuracy)**

When an LLM has access to your reviewed knowledge graph, its outputs become dramatically more accurate.

### Hallucination

When a model generates plausible-sounding but false information. This is not a bug -- it is an inherent property of how text prediction works. The model optimizes for likelihood, not truth. This is exactly why human review matters.

**[Local Models](../llm/local-models)**

Small language models that run on your own machine (via Ollama, or fully in-browser via WebAssembly).

**[Models Are Tools, Not Thinkers](../llm/not-magic)**

A language model is a tool -- powerful, but still a tool.

### Prompt Engineering

The art of structuring input to get useful output from a language model. A Reckoning is a structured prompt: Situation + Target + your graph context. The better the input, the better the output.

## Related

- [Graph-Grounded Accuracy](../llm/kb-grounded-accuracy)
- [What Language Models Actually Are](../llm/what-ll-ms-are)
