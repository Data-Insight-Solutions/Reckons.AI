---
title: "What Is Reckons.AI"
slug: "what-is-reckons-ai"
order: 1015
section: "Guide"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI is a personal knowledge graph that runs entirely in your browser."
generated: "docs-kb"
related:
  - "triple-architecture"
  - "why-it-matters"
---

# What Is Reckons.AI

*Concept*

Reckons.AI is a personal knowledge graph that runs entirely in your browser. No server, no account, no cloud dependency. Your data stays on your device in IndexedDB, and you control every piece of knowledge that enters your graph through a human review process.

## Where to go next

**[LEAP: Triples & RDF Deep Dive](../guide/triples-and-rdf)**

Click to explore the semantic triple architecture, Turtle syntax, RDF standards (RDFS, SKOS, SPARQL, JSON-LD, PROV-O), and knowledge graph fundamentals.

**[LEAP: Language Models](../guide/language-models)**

Click to learn what LLMs actually are, why they hallucinate, how RAG works, and why your curated graph makes AI dramatically more accurate.

**[LEAP: Use Cases](../guide/use-cases)**

Click to explore real-world scenarios: insurance claims, legal disputes, employment rights, medical records, corporate pushback, and research.

**[LEAP: Features](../guide/features)**

Click for detailed coverage of every feature: Ingest, Review, Trust, Graph, Shelly, Reckonings, Compare, Multi-Graph, graph Leap, Content Safety, Predicate Manager, Whisper STT, Kokoro TTS, and more.

**[LEAP: Integrations & Tech](../guide/integrations-tech)**

Click for integrations (Calendar, MCP, Extension, Whisper, Kokoro, OCR, Firecrawl, Meshy 3D) and the technology stack (SvelteKit 2, Threlte 8, N3.js, @huggingface/transformers, Dexie).

**[LEAP: Tips & Security](../guide/tips-security)**

Click for practical tips (start small, review carefully, export often, use Ollama offline) and the security architecture (no server, API key safety, content safety, CSP, offline-capable).

**[LEAP: Timeline & RDF Ecosystem](../guide/timeline-ecosystem)**

Click for the RDF timeline from 1999 to 2026, key organizations (W3C, AI Alliance, Schema.org), people (Tim Berners-Lee), and the Reckons.AI launch.

**[LEAP: Architecture & Design](../guide/architecture-guide)**

Click for architecture decisions, TTL-first documentation strategy, standards alignment (PROV-O, SKOS), deployment patterns, style conventions, dependency health, and the markdown migration tracker.

**[LEAP: Test Suite & Visual Regression](../guide/testing)**

Click for test documentation as interactive stories.

**[3D / 2D Knowledge Graph](../features/graph3-d)**

Interactive force-directed graph in WebGL (3D) or Canvas (2D fallback).

**[Compare / Diff Engine](../features/compare)**

Compare two knowledge graphs or snapshots at /compare.

**[Content Safety](../features/content-safety-features)**

Ethics preamble injected into ALL LLM system prompts.

**[Context Compression](../features/context-compression-features)**

Condense your context.

**[Cross-Graph Alignment](../features/cross-kb-alignment)**

Align entities across knowledge graphs.

**[Currents](../features/currents)**

Streamed ingest: point a current at an RSS feed, URL, or topic and it brings recurring external content into your graph on a schedule.

**[Currents Settings as Meta Triples](../architecture/currents-meta-triples)**

Per-graph currents configuration (allowed entity types, per-current source/cadence/label) lives IN the graph as ordinary statements under the urn:reckons:meta/currents/ namespace, the same pattern used by nav:order for hierarchy.

**[Disambiguation](../features/disambiguation)**

Automatic detection of duplicate or similar entities using text embeddings and cosine similarity.

**[Entity Type System](../features/entity-types)**

Categorize entities (Person, Place, Concept, Tool, Document, Organization, Event) with custom colors and 3D shapes.

**[Getting Started](../guide/getting-started)**

A step-by-step guide to building your first knowledge graph.

**[History Mode](../features/history-mode)**

Time-travel through your graph at /history.

**[Human-in-the-Loop](../guide/human-in-the-loop)**

Nothing enters your confirmed knowledge graph without your explicit review.

**[Ingest](../features/ingest)**

Add knowledge from text, URLs, documents, calendars, iCal feeds, Indico events, or Turtle files.

**[LLM Backends](../features/llm-backends)**

9 providers: Claude, OpenAI, Gemini, Ollama (local), OpenRouter (free tier), WASM (offline, Qwen2.5-0.5B-Instruct), Chrome AI (Gemini Nano), Manual paste, Mock.

**[Local-First Architecture](../architecture/local-first-arch)**

All user data lives in browser IndexedDB (Dexie v4).

**[Local-First Architecture](../guide/local-first)**

Everything runs in the browser.

**[MCP Workspace](../features/mcp-workspace)**

Reckons.AI uses its own MCP server to track product state.

**[Multi-Graph Management](../features/multi-kb)**

Create, switch, rename, and delete independent knowledge graphs.

**[Open Source (MIT)](../guide/open-source)**

Reckons.AI is MIT-licensed.

**[Passage Grounding](../features/passage-grounding)**

Verbatim source excerpts attached to extracted triples.

**[Predicate Manager](../features/predicate-manager)**

View all predicates in your graph with usage counts.

**[Published Graph Site](../features/published-docs)**

Any graph can publish itself as a browsable website.

**[Reckoning (STP)](../features/reckoning)**

Situation-Target-Proposal: describe your situation, state your goal, and the AI synthesizes options grounded ONLY in your confirmed triples.

**[Review System](../features/review-system)**

Three tabs: Incoming (new triples), Deletions (removal proposals), Merges (duplicate entity suggestions).

**[Schema-Constrained Local Extraction](../architecture/schema-constrained-extraction)**

Small local models (via Ollama) are unreliable at freeform triple extraction, so the local extraction path constrains the model to a fixed JSON schema (subject/predicate/object/type fields) with a compact prompt rather than the richer freeform prompt used for cloud backends.

**[Shelly (AI Assistant)](../features/shelly)**

The turtle-shaped AI assistant.

**[Source Refresh](../features/source-refresh)**

Generic refresh for url, repository, and calendar sources.

**[Source Trust System](../features/trust-system)**

Sources accumulate trust scores based on your review decisions.

**[Style Conventions](../architecture/style-conventions)**

Brand: dark theme, accent #7dd3fc (sky-300).

**[Tailwind-Without-Preflight Containment](../architecture/tailwind-containment)**

shadcn-svelte components are introduced on Tailwind v4 with Tailwind's CSS reset (preflight) disabled.

**[Technology Stack](../integrations-tech/architecture-integrations-tech)**

Static SvelteKit 2 app with Svelte 5 runes.

**[TTL-First Documentation](../architecture/ttl-first-docs)**

Reckons.AI uses its own TTL knowledge graphs as the primary documentation format.

**[Turtle Export](../features/ttl-export)**

Export your graph as a .ttl file with full reification metadata (status, source, confidence, timestamps, excerpts).

**[Why Reckons.AI Matters](../guide/why-it-matters)**

In an era of information overload, Reckons.AI gives individuals a structured way to capture, verify, connect, and retrieve knowledge.

## Related

**Related**

- [The Semantic Triple](../triples-rdf/triple-architecture)
- [Why Reckons.AI Matters](../guide/why-it-matters)
