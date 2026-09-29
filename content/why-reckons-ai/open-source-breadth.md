---
title: "Why not just use an open-source tool?"
slug: "open-source-breadth"
order: 14
section: "Why Reckons.AI"
parent: "why-reckons"
template: doc
status: published
nav: sidebar
excerpt: "Because the field splits this problem in two and solves each half separately."
generated: "docs-kb"
---

# Why not just use an open-source tool?

Because the field splits this problem in two and solves each half separately. The personal knowledge tools, including Logseq, SiYuan, Trilium and Obsidian, have spent years making capture effortless, but their graph is a backlink graph over documents: the nodes are pages and the links mean nothing in particular, so you cannot ask the graph a question. The RDF tools model meaning properly and assume you arrive with an ontology, a server and a SPARQL endpoint. Reckons.AI is the part in between, and it stands on the notes side of it. You capture the way you would anywhere else, and what comes back is a graph.

<p class="derived">It has 3 parts below.</p>

## Why it is this way

**Principle**

The gap is not another triplestore. It is the loop that turns unstructured sources into reviewed facts, with a person deciding what is true, and then a way to actually see the result.

**Honest Note**

The capture half is where they are ahead and where we have to match them, not where we differentiate. Logseq and Obsidian have spent years making it effortless to get a thought into the app. Friction we add at that step is not rigour, it is a reason to use something else, and a typed graph is worth nothing to someone who never got their note in.

## In this section

### The combination is the product

Individually, most of these exist elsewhere in open source. What is hard to find is all of them in one MIT-licensed app that opens offline. Listed in the order a person meets them: capture by typing, pasting or speaking, with speech-to-text in and speech out, both on the device; extraction that proposes triples using a local model or a cloud one; a review workflow where every fact carries its source and its status; a conversational agent grounded in your own graph; on-device embeddings for semantic search; ingest from repositories and the web; a 2D and 3D navigable graph whose nodes can carry an image, a video or an orbitable 3D model; an MCP server so external agents can query the graph; and publishing from the graph to a website.

#### Why it is this way

**Principle**

The list is ordered by what a normal person needs first, deliberately. Leading with the 3D graph and the MCP server sells the product to people who already agree with it and tells everybody else this is not for them.

**Honest Note**

Saying nobody else combines these is a claim about the field we have surveyed, not about every repository on earth, and breadth is not automatically a virtue. A specialist tool that does one of these better than we do is a legitimate choice, and static/reckons-competitive.ttl names several that do.

#### What we found

**Evidence**

Statuses verified in static/reckons-shipped.ttl and static/reckons-roadmap.ttl on 2026-09-16. The core graph, multi-graph management, the MCP server, repository ingest, the browser extension, Whisper speech-to-text, Kokoro speech output, the chat agent and content safety are all in production. The image, video and 3D asset viewer is functional. Graph publishing is in progress.

### A graph you can actually look at

Enterprise ontology tools render boxes and arrows for data engineers, and note apps render a hairball nobody navigates by. Reckons.AI treats the graph as a place, with 3D navigation, hierarchical layouts, per-entity icons, and nodes that can carry a photograph, a video clip or an orbitable 3D model. An asset attaches to the thing it depicts, so the thing and the facts about it sit together.

#### Why it is this way

**Principle**

Legibility is a feature rather than decoration. A graph that quietly teaches you how the pieces fit is worth more than one that impresses you with how complex your data is.

**Honest Note**

This is also the easiest thing here to dismiss as a gimmick, and for a pure data-engineering workflow that criticism is fair. It earns its place in exploration, and in explaining a graph to somebody who does not already think in triples.

### Where the open-source field beats us

Logseq and SiYuan each have tens of thousands of stars and a maturity we do not approach. CodeFlow holds the local-first line more purely than we do, in a single HTML file with no build step and no server. SiYuan has solved self-hosted sync, which we currently answer with a no. These are recorded in static/reckons-competitive.ttl alongside what we intend to learn from each.

#### Why it is this way

**Principle**

Competition here is healthy and open. A comparison that only flatters its author is not research, and the reader can tell.
