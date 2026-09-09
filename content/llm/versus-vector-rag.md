---
title: "Reckons.AI compared with vector search and RAG"
slug: "versus-vector-rag"
order: 62
section: "LLM"
parent: "what-ll-ms-are"
template: doc
status: published
nav: sidebar
excerpt: "Vector search and Reckons.AI answer different questions, and most of the confusion between them comes from pretending they answer the same one."
generated: "docs-kb"
related:
  - "kb-grounded-accuracy"
---

# Reckons.AI compared with vector search and RAG

Vector search and Reckons.AI answer different questions, and most of the confusion between them comes from pretending they answer the same one. A vector index answers what does this remind me of. A reviewed graph answers what do I actually hold, and what does it contradict. Neither is a better version of the other, and the honest recommendation at the bottom of this page is to use both.

## At a glance

**Audience**

Anyone who already has a RAG pipeline, or is deciding whether to build one, and wants to know what this does differently.

## Why it is this way

**Principle**

THE UNIT IS THE WHOLE DIFFERENCE. RAG retrieves CHUNKS OF TEXT chosen by vector proximity; a passage that reads like the question comes back, and the model reads it and writes an answer. Reckons.AI retrieves CLAIMS a person has confirmed, each with the sentence it came from. Everything else on this page follows from that one choice, in both directions.

**Constraint**

THEY COMPOSE, AND THIS PRODUCT ALREADY USES BOTH. Reckons.AI ships BM25 full-text search and BGE-small embeddings, and uses vector similarity for entity disambiguation — deciding that two names probably mean one thing is a similarity problem, not a logical one. The useful architecture is usually vectors for RECALL and a graph for JUDGEMENT: let similarity find the candidates, and let a reviewed structure decide what is true. Treating them as rivals costs you one of the two.

## What we found

**Measured**

- AND OUR OWN CONTEXT-SAVING CLAIM WAS ONCE WRONG. The compression FORMAT saves about 18% against grouped Turtle and 29% against flat Turtle. This project previously claimed 60-70%, which conflated the encoding with SUBGRAPH SELECTION — returning the relevant slice instead of the whole graph, which is where the large saving actually lives. Writing the test falsified the headline. It is recorded here because a comparison page is exactly where an inflated number would do the most damage.
- EXTRACTION IS LOSSY, AND THE NUMBER IS NOT FLATTERING. Measured against this repository's own scored corpus, local models recover 53-63% of the expected facts on a median run, with a 42-point spread on the least stable model. A vector index loses nothing on ingest because it stores the text. So the graph gains its properties by paying a real price at the door, and anyone comparing the two should know the size of that price rather than hearing only about the benefits.
- THE VOCABULARY PROBLEM IS REAL AND MEASURED HERE, and it cuts both ways. On 2026-09-08 six local models each read the same short document five times: twelve relations came back under FIFTY-ONE different names, and dropped-because alone was written eleven ways. In a chunk index those eleven phrasings are eleven unrelated strings, and a keyword search finds some and misses the rest — this is the case FOR structure. But it is also the case AGAINST it, honestly read: getting from eleven phrasings to one predicate is exactly the work a graph makes you do, and vector similarity gets a useful approximation of it for free.

**Example**

- WHAT A REVIEWED GRAPH DOES THAT VECTOR SEARCH STRUCTURALLY CANNOT. It can tell you two sources DISAGREE. Two chunks that contradict each other are two chunks with high similarity to the same query, and nothing in the index knows they cannot both be true; two triples with the same subject and predicate and different objects are a contradiction by construction, detectable without reading anything. It can answer a question about ABSENCE — what do I not know — which a similarity search cannot express, because the nearest neighbour of a question with no answer is still some passage. It can be CORRECTED once: fix a fact and every answer that rests on it changes, where re-embedding a corrected document leaves every stale chunk exactly where it was. And its provenance is per-claim rather than per-chunk, so a citation points at the sentence that supports the fact rather than at the paragraph it was near.
- WHAT VECTOR SEARCH DOES BETTER, and it is not a short list. It needs no extraction step, so ingesting a thousand documents costs an embedding pass and nothing else — no review queue, no human in the loop, no decisions. It handles a question phrased in words the corpus never uses, because proximity in embedding space does not require anyone to have agreed on vocabulary. It degrades gracefully: a bad match returns a slightly-off passage rather than nothing. And it scales to corpora far beyond what anyone would sit and review. If your problem is find me the part of these ten thousand pages that talks about X, a vector index is the right tool and a graph is a slower way to get a worse answer.

## What is not done

**Open Question**

WHEN IS THE REVIEW STEP WORTH IT? The honest answer is that it depends on how long you keep the knowledge and how much a wrong answer costs. For a question you will ask once about documents you will never revisit, review is pure overhead and RAG wins outright. For a body of knowledge you will hold for years, be asked to justify, and correct as you learn — a dispute, a diagnosis, a decision record — the review is the product and its absence is what makes the alternative cheap.

## Related

- [Graph-Grounded Accuracy](../llm/kb-grounded-accuracy)
