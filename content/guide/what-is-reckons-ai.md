---
title: "What Is Reckons.AI"
slug: "what-is-reckons-ai"
order: 10
section: "Guide"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI is a personal knowledge graph that runs entirely in your browser."
generated: "docs-kb"
related:
  - "triple-architecture"
---

# What Is Reckons.AI

Reckons.AI is a personal knowledge graph that runs entirely in your browser. No server, no account, no cloud dependency. Your data stays on your device in IndexedDB, and you control every piece of knowledge that enters your graph through a human review process.

## In this section

### [LEAP: Triples & RDF Deep Dive](../triples-rdf/triple-architecture)

Click to explore the semantic triple architecture, Turtle syntax, RDF standards (RDFS, SKOS, SPARQL, JSON-LD, PROV-O), and knowledge graph fundamentals.

### [LEAP: Language Models](../llm/what-ll-ms-are)

Click to learn what LLMs actually are, why they hallucinate, how RAG works, and why your curated graph makes AI dramatically more accurate.

### [LEAP: Use Cases](../use-cases/personal-empowerment)

Click to explore real-world scenarios: insurance claims, legal disputes, employment rights, medical records, corporate pushback, and research.

### [LEAP: Features](../features/shelly)

Click for detailed coverage of every feature: Ingest, Review, Trust, Graph, Shelly, Reckonings, Compare, Multi-Graph, graph Leap, Content Safety, Predicate Manager, Whisper STT, Kokoro TTS, and more.

### [LEAP: Integrations & Tech](../integrations-tech/integrations)

Click for integrations (Calendar, MCP, Extension, Whisper, Kokoro, OCR, Firecrawl, Meshy 3D) and the technology stack (SvelteKit 2, Threlte 8, N3.js, @huggingface/transformers, Dexie).

### [LEAP: Tips & Security](../tips/security)

Click for practical tips (start small, review carefully, export often, use Ollama offline) and the security architecture (no server, API key safety, content safety, CSP, offline-capable).

### [LEAP: Timeline & RDF Ecosystem](../timeline-ecosystem/rdf10)

Click for the RDF timeline from 1999 to 2026, key organizations (W3C, AI Alliance, Schema.org), people (Tim Berners-Lee), and the Reckons.AI launch.

### [LEAP: Architecture & Design](../user-paths/core-loop)

Click for architecture decisions, TTL-first documentation strategy, standards alignment (PROV-O, SKOS), deployment patterns, style conventions, dependency health, and the markdown migration tracker.

### [LEAP: Test Suite & Visual Regression](../testing/test-suite)

Click for test documentation as interactive stories. Walk through user story E2E tests step-by-step with screenshots attached to each node. Covers Dev Sprint Planning, User Docs Import, Cross-Graph Alignment, and page-level visual regression.

**[Shelly (AI Assistant)](../features/shelly)**

The turtle-shaped AI assistant.

**[3D / 2D Knowledge Graph](../features/graph3-d)**

Interactive force-directed graph in WebGL (3D) or Canvas (2D fallback).

**[Compare / Diff Engine](../features/compare)**

Compare two knowledge graphs or snapshots at /compare.

### Content Safety

Ethics preamble injected into ALL LLM system prompts. Content classifier with two levels: blocked (filtered out on ingest) and mature (flagged on export with advisory). Discourse, disagreement, and academic content pass freely.

**[Context Compression](../features/context-compression-features)**

Condense your context.

### Cross-Graph Alignment

Align entities across knowledge graphs. Entity matching via exact IRI match and embedding similarity. IRI remapping for entities that represent the same concept across graphs. Align tab in review page. KbPicker selects source graph, AlignmentCard shows each match with accept/reject.

**[Currents](../features/currents)**

Streamed ingest: point a current at an RSS feed, URL, or topic and it brings recurring external content into your graph on a schedule.

**[Currents Settings as Meta Triples](../architecture/currents-meta-triples)**

Per-graph currents configuration (allowed entity types, per-current source/cadence/label) lives IN the graph as ordinary statements under the urn:reckons:meta/currents/ namespace, the same pattern used by nav:order for hierarchy.

### Disambiguation

Automatic detection of duplicate or similar entities using text embeddings and cosine similarity. Suggests merges for your review in the Merges tab.

### Entity Type System

Categorize entities (Person, Place, Concept, Tool, Document, Organization, Event) with custom colors and 3D shapes. Types assigned via rdf:type statements.

**[Getting Started](../guide/getting-started)**

A step-by-step guide to building your first knowledge graph.

### History Mode

Time-travel through your graph at /history. Scrub a timeline to see the graph at any past point. All mutations are logged in the changelog.

### Human-in-the-Loop

Nothing enters your confirmed knowledge graph without your explicit review. Every triple extracted by an LLM starts as 'pending' and must be confirmed, rejected, or refined by you. You are the authority.

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

### Open Source (MIT)

Reckons.AI is MIT-licensed. Read the code, fork it, self-host it, run it offline forever. No proprietary lock-in, no subscription, no way to lose access to your own tool.

### Passage Grounding

Verbatim source excerpts attached to extracted triples. LLM prompt rule requests the exact source sentence. Persists via meta:excerpt in TTL reification. Displayed in StatementCard and DiffEntry.

### Predicate Manager

View all predicates in your graph with usage counts. Rename predicates across all statements or merge two predicates into one. Accessible from the graph page.

**[Published Graph Site](../features/published-docs)**

Any graph can publish itself as a browsable website.

### Reckoning (STP)

Situation-Target-Proposal: describe your situation, state your goal, and the AI synthesizes options grounded ONLY in your confirmed triples. Every option cites its sources.

**[Review System](../features/review-system)**

Three tabs: Incoming (new triples), Deletions (removal proposals), Merges (duplicate entity suggestions).

**[Schema-Constrained Local Extraction](../architecture/schema-constrained-extraction)**

Small local models (via Ollama) are unreliable at freeform triple extraction, so the local extraction path constrains the model to a fixed JSON schema (subject/predicate/object/type fields) with a compact prompt rather than the richer freeform prompt used for cloud backends.

**[Source Refresh](../features/source-refresh)**

Generic refresh for url, repository, and calendar sources.

### Source Trust System

Sources accumulate trust scores based on your review decisions. Trusted sources can be auto-confirmed. A time-decay formula prevents stale trust from persisting.

**[Style Conventions](../architecture/style-conventions)**

Brand: dark theme, accent #7dd3fc (sky-300).

**[Tailwind-Without-Preflight Containment](../architecture/tailwind-containment)**

shadcn-svelte components are introduced on Tailwind v4 with Tailwind's CSS reset (preflight) disabled.

**[Technology Stack](../integrations-tech/architecture-integrations-tech)**

Static SvelteKit 2 app with Svelte 5 runes.

**[TTL-First Documentation](../architecture/ttl-first-docs)**

Reckons.AI uses its own TTL knowledge graphs as the primary documentation format.

### Turtle Export

Export your graph as a .ttl file with full reification metadata (status, source, confidence, timestamps, excerpts). Roundtrip-safe. Clean export for interop or full export with all metadata.

### Why Reckons.AI Matters

In an era of information overload, Reckons.AI gives individuals a structured way to capture, verify, connect, and retrieve knowledge. It bridges the gap between human understanding and machine processing -- your knowledge becomes queryable, shareable, and portable.

## Related

- [The Semantic Triple](../triples-rdf/triple-architecture)
- [What Is Reckons.AI](../guide/what-is-reckons-ai)
