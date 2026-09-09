---
title: "RAG (Retrieval-Augmented Generation)"
slug: "retrieval-augmented"
order: 1006
section: "LLM"
parent: "kb-grounded-accuracy"
template: doc
status: published
nav: sidebar
excerpt: "Retrieval-Augmented Generation: before answering, a system fetches passages that look relevant to the question and puts them in the prompt."
generated: "docs-kb"
related:
  - "versus-vector-rag"
---

# RAG (Retrieval-Augmented Generation)

Retrieval-Augmented Generation: before answering, a system fetches passages that look relevant to the question and puts them in the prompt. In the usual form, retrieval is by VECTOR SIMILARITY — documents are split into chunks, each chunk is turned into a vector by an embedding model, and the question is turned into a vector too; the chunks whose vectors sit nearest the question are the ones the model gets to read.

## Why it is this way

**Honest Note**

THIS PAGE PREVIOUSLY DEFINED RAG AS retrieving facts FROM A KNOWLEDGE GRAPH, which is not what RAG means — it is what THIS product does. Defining a competing approach as though it were our own is the most comfortable kind of error and the least useful, so the definition above describes the ordinary vector-and-chunks form that most people mean by the word. The comparison with what Reckons.AI does is a separate page, because it is a real comparison rather than a definition.

## Related

- [Reckons.AI compared with vector search and RAG](../llm/versus-vector-rag)
