---
title: "Working with AI models"
slug: "ai-models"
order: 4
section: "Build"
template: doc
status: published
nav: sidebar
excerpt: "What the models do here, what they are not trusted with, and how to run them locally."
generated: "docs-composed"
---

# Working with AI models

What the models do here, what they are not trusted with, and how to run them locally.

### Built on Human Knowledge

Every layer of a language model relies on human work. The training corpus is human-written text. The architecture was designed by human researchers. RLHF alignment uses human judgments. The model's outputs are a reflection of collective human knowledge, filtered through statistical compression.

### Graph-Grounded Accuracy

When an LLM has access to your reviewed knowledge graph, its outputs become dramatically more accurate. Instead of guessing from training data, it retrieves your confirmed facts. This is called retrieval-augmented generation (RAG) -- and the quality of the retrieval source is everything. Your curated graph is the best source possible.

See also: [What it does](/docs/learn/what-it-does)

### Hallucination

When a model generates plausible-sounding but false information. This is not a bug -- it is an inherent property of how text prediction works. The model optimizes for likelihood, not truth. This is exactly why human review matters.

See also: [Start here](/docs/learn/start-here)

### Local Models

Small language models that run on your own machine (via Ollama, or fully in-browser via WebAssembly). They are less capable than frontier cloud models but keep your data private, cost nothing per call, and work offline. Reckons.AI uses them where they score well: chat, diff summaries, and merge analysis can prefer a reachable local model automatically, while harder extraction stays with your chosen backend.

See also: [What it does](/docs/learn/what-it-does)

### Models Are Tools, Not Thinkers

A language model is a tool -- powerful, but still a tool. It cannot verify its own outputs, does not know what is true, and will confidently produce plausible-sounding falsehoods. Calling them 'AI' implies agency they do not have. Treat them as highly capable text prediction engines.

### Prompt Engineering

The art of structuring input to get useful output from a language model. A Reckoning is a structured prompt: Situation + Target + your graph context. The better the input, the better the output.

See also: [What it does](/docs/learn/what-it-does)

### RAG (Retrieval-Augmented Generation)

Retrieval-Augmented Generation: before answering, a system fetches passages that look relevant to the question and puts them in the prompt. In the usual form, retrieval is by VECTOR SIMILARITY — documents are split into chunks, each chunk is turned into a vector by an embedding model, and the question is turned into a vector too; the chunks whose vectors sit nearest the question are the ones the model gets to read.

### Reckons.AI compared with vector search and RAG

Vector search and Reckons.AI answer different questions, and most of the confusion between them comes from pretending they answer the same one. A vector index answers what does this remind me of. A reviewed graph answers what do I actually hold, and what does it contradict. Neither is a better version of the other, and the honest recommendation at the bottom of this page is to use both.

### Structured Outputs

Instead of asking a model for free-form text and hoping it is parseable, structured output constrains generation to a fixed schema (specific fields, specific types). This matters most for small local models: a 1-4B parameter model frequently produces broken free-form JSON but stays reliable when the schema is enforced. Reckons.AI uses schema-constrained extraction so local models can turn text into clean facts -- which still land as pending for your review.

### What Language Models Actually Are

The models people call 'AI' are trained statistical models built with human knowledge at every level. Humans wrote the training data, designed the architecture, labeled the fine-tuning examples, and aligned the outputs. These models predict likely text based on patterns -- they do not think, reason, or understand.
