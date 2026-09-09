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

<p class="derived">It has 43 parts below.</p>

## In this section

### Read next

<div class="card-grid">

<a class="card" href="../triples-rdf/triple-architecture"><span class="card-title">Triples & RDF Deep Dive</span><span class="card-text">The semantic triple, Turtle syntax, and the RDF standards this product is built on — RDFS, SKOS, SPARQL, JSON-LD and PROV-O.</span></a>
<a class="card" href="../llm/what-ll-ms-are"><span class="card-title">Language Models</span><span class="card-text">What language models actually are, why they hallucinate, how retrieval-augmented generation works, and how a reviewed graph compares with it.</span></a>
<a class="card" href="../use-cases/personal-empowerment"><span class="card-title">Use Cases</span><span class="card-text">Worked scenarios: insurance claims, legal disputes, employment rights, medical records, corporate pushback, research, and software engineering.</span></a>
<a class="card" href="../features/five-moves"><span class="card-title">Features</span><span class="card-text">detailed coverage of every feature: Ingest, Review, Trust, Graph, Shelly, Reckonings, Compare, Multi-Graph, graph Leap, Content Safety, Predicate Manager, Whisper STT, Kokoro TTS, and more.</span></a>
<a class="card" href="../integrations-tech/integrations"><span class="card-title">Integrations & Tech</span><span class="card-text">integrations (Calendar, MCP, Extension, Whisper, Kokoro, OCR, Firecrawl, Meshy 3D) and the technology stack (SvelteKit 2, Threlte 8, N3.js, @huggingface/transformers, Dexie).</span></a>
<a class="card" href="../tips/security"><span class="card-title">Tips & Security</span><span class="card-text">practical tips (start small, review carefully, export often, use Ollama offline) and the security architecture (no server, API key safety, content safety, CSP, offline-capable).</span></a>
<a class="card" href="../timeline-ecosystem/semantic-web-timeline"><span class="card-title">Timeline & RDF Ecosystem</span><span class="card-text">the RDF timeline from 1999 to 2026, key organizations (W3C, AI Alliance, Schema.org), people (Tim Berners-Lee), and the Reckons.AI launch.</span></a>
<a class="card" href="../architecture/ttl-vs-markdown-gaps"><span class="card-title">Architecture & Design</span><span class="card-text">architecture decisions, TTL-first documentation strategy, standards alignment (PROV-O, SKOS), deployment patterns, style conventions, dependency health, and the markdown migration tracker.</span></a>
<a class="card" href="../testing/test-suite"><span class="card-title">Test Suite & Visual Regression</span><span class="card-text">test documentation as interactive stories.</span></a>

</div>

### What it can do

<div class="card-grid">

<a class="card" href="../features/graph3-d"><span class="card-title">3D / 2D Knowledge Graph</span><span class="card-text">Interactive force-directed graph in WebGL (3D) or Canvas (2D fallback).</span></a>
<a class="card" href="../features/compare"><span class="card-title">Compare / Diff Engine</span><span class="card-text">Compare two knowledge graphs or snapshots at /compare.</span></a>
<a class="card" href="#content-safety-features"><span class="card-title">Content Safety</span><span class="card-text">Ethics preamble injected into ALL LLM system prompts.</span></a>
<a class="card" href="../features/context-compression-features"><span class="card-title">Context Compression</span><span class="card-text">Condense your context.</span></a>
<a class="card" href="#cross-kb-alignment"><span class="card-title">Cross-Graph Alignment</span><span class="card-text">Align entities across knowledge graphs.</span></a>
<a class="card" href="../features/currents"><span class="card-title">Currents</span><span class="card-text">Streamed ingest: point a current at an RSS feed, URL, or topic and it brings recurring external content into your graph on a schedule.</span></a>
<a class="card" href="../architecture/currents-meta-triples"><span class="card-title">Currents Settings as Meta Triples</span><span class="card-text">Per-graph currents configuration (allowed entity types, per-current source/cadence/label) lives IN the graph as ordinary statements under the urn:reckons:meta/currents/ namespace, the same pattern used by nav:order for hierarchy.</span></a>
<a class="card" href="#disambiguation"><span class="card-title">Disambiguation</span><span class="card-text">Automatic detection of duplicate or similar entities using text embeddings and cosine similarity.</span></a>
<a class="card" href="#entity-types"><span class="card-title">Entity Type System</span><span class="card-text">Categorize entities (Person, Place, Concept, Tool, Document, Organization, Event) with custom colors and 3D shapes.</span></a>
<a class="card" href="#history-mode"><span class="card-title">History Mode</span><span class="card-text">Time-travel through your graph at /history.</span></a>
<a class="card" href="#human-in-the-loop"><span class="card-title">Human-in-the-Loop</span><span class="card-text">Nothing enters your confirmed knowledge graph without your explicit review.</span></a>
<a class="card" href="../features/ingest"><span class="card-title">Ingest</span><span class="card-text">Add knowledge from text, URLs, documents, calendars, iCal feeds, Indico events, or Turtle files.</span></a>
<a class="card" href="../features/llm-backends"><span class="card-title">LLM Backends</span><span class="card-text">9 providers: Claude, OpenAI, Gemini, Ollama (local), OpenRouter (free tier), WASM (offline, Qwen2.5-0.5B-Instruct), Chrome AI (Gemini Nano), Manual paste, Mock.</span></a>
<a class="card" href="../architecture/local-first-arch"><span class="card-title">Local-First Architecture</span><span class="card-text">All user data lives in browser IndexedDB (Dexie v4).</span></a>
<a class="card" href="../guide/local-first"><span class="card-title">Local-First Architecture</span><span class="card-text">Everything runs in the browser.</span></a>
<a class="card" href="../features/mcp-workspace"><span class="card-title">MCP Workspace</span><span class="card-text">Reckons.AI uses its own MCP server to track product state.</span></a>
<a class="card" href="../features/multi-kb"><span class="card-title">Multi-Graph Management</span><span class="card-text">Create, switch, rename, and delete independent knowledge graphs.</span></a>
<a class="card" href="#open-source"><span class="card-title">Open Source (MIT)</span><span class="card-text">Reckons.AI is MIT-licensed.</span></a>
<a class="card" href="#passage-grounding"><span class="card-title">Passage Grounding</span><span class="card-text">Verbatim source excerpts attached to extracted triples.</span></a>
<a class="card" href="#predicate-manager"><span class="card-title">Predicate Manager</span><span class="card-text">View all predicates in your graph with usage counts.</span></a>
<a class="card" href="../features/published-docs"><span class="card-title">Published Graph Site</span><span class="card-text">Any graph can publish itself as a browsable website.</span></a>
<a class="card" href="#reckoning"><span class="card-title">Reckoning (STP)</span><span class="card-text">Situation-Target-Proposal: describe your situation, state your goal, and the AI synthesizes options grounded ONLY in your confirmed triples.</span></a>
<a class="card" href="../features/review-system"><span class="card-title">Review System</span><span class="card-text">Three tabs: Incoming (new triples), Deletions (removal proposals), Merges (duplicate entity suggestions).</span></a>
<a class="card" href="../architecture/schema-constrained-extraction"><span class="card-title">Schema-Constrained Local Extraction</span><span class="card-text">Small local models (via Ollama) are unreliable at freeform triple extraction, so the local extraction path constrains the model to a fixed JSON schema (subject/predicate/object/type fields) with a compact prompt rather than the richer freeform prompt used for cloud backends.</span></a>
<a class="card" href="../features/source-refresh"><span class="card-title">Source Refresh</span><span class="card-text">Generic refresh for url, repository, and calendar sources.</span></a>
<a class="card" href="#trust-system"><span class="card-title">Source Trust System</span><span class="card-text">Sources accumulate trust scores based on your review decisions.</span></a>
<a class="card" href="../architecture/style-conventions"><span class="card-title">Style Conventions</span><span class="card-text">Brand: dark theme, accent #7dd3fc (sky-300).</span></a>
<a class="card" href="../architecture/tailwind-containment"><span class="card-title">Tailwind-Without-Preflight Containment</span><span class="card-text">shadcn-svelte components are introduced on Tailwind v4 with Tailwind's CSS reset (preflight) disabled.</span></a>
<a class="card" href="../integrations-tech/architecture-integrations-tech"><span class="card-title">Technology Stack</span><span class="card-text">Static SvelteKit 2 app with Svelte 5 runes.</span></a>
<a class="card" href="../architecture/ttl-first-docs"><span class="card-title">TTL-First Documentation</span><span class="card-text">Reckons.AI uses its own TTL knowledge graphs as the primary documentation format.</span></a>
<a class="card" href="#ttl-export"><span class="card-title">Turtle Export</span><span class="card-text">Export your graph as a .ttl file with full reification metadata (status, source, confidence, timestamps, excerpts).</span></a>
<a class="card" href="#why-it-matters"><span class="card-title">Why Reckons.AI Matters</span><span class="card-text">In an era of information overload, Reckons.AI gives individuals a structured way to capture, verify, connect, and retrieve knowledge.</span></a>

</div>

### Reference

<div class="card-grid">

<a class="card" href="../guide/getting-started"><span class="card-title">Getting Started</span><span class="card-text">A step-by-step guide to building your first knowledge graph.</span></a>

</div>

### People

<div class="card-grid">

<a class="card" href="../features/shelly"><span class="card-title">Shelly (AI Assistant)</span><span class="card-text">The turtle-shaped AI assistant.</span></a>

</div>

<h3 id="content-safety-features">Content Safety</h3>

Ethics preamble injected into ALL LLM system prompts. Content classifier with two levels: blocked (filtered out on ingest) and mature (flagged on export with advisory). Discourse, disagreement, and academic content pass freely.

<h3 id="cross-kb-alignment">Cross-Graph Alignment</h3>

Align entities across knowledge graphs. Entity matching via exact IRI match and embedding similarity. IRI remapping for entities that represent the same concept across graphs. Align tab in review page. KbPicker selects source graph, AlignmentCard shows each match with accept/reject.

<h3 id="disambiguation">Disambiguation</h3>

Automatic detection of duplicate or similar entities using text embeddings and cosine similarity. Suggests merges for your review in the Merges tab.

<h3 id="entity-types">Entity Type System</h3>

Categorize entities (Person, Place, Concept, Tool, Document, Organization, Event) with custom colors and 3D shapes. Types assigned via rdf:type statements.

<h3 id="history-mode">History Mode</h3>

Time-travel through your graph at /history. Scrub a timeline to see the graph at any past point. All mutations are logged in the changelog.

<h3 id="human-in-the-loop">Human-in-the-Loop</h3>

Nothing enters your confirmed knowledge graph without your explicit review. Every triple extracted by an LLM starts as 'pending' and must be confirmed, rejected, or refined by you. You are the authority.

<h3 id="open-source">Open Source (MIT)</h3>

Reckons.AI is MIT-licensed. Read the code, fork it, self-host it, run it offline forever. No proprietary lock-in, no subscription, no way to lose access to your own tool.

<h3 id="passage-grounding">Passage Grounding</h3>

Verbatim source excerpts attached to extracted triples. LLM prompt rule requests the exact source sentence. Persists via meta:excerpt in TTL reification. Displayed in StatementCard and DiffEntry.

<h3 id="predicate-manager">Predicate Manager</h3>

View all predicates in your graph with usage counts. Rename predicates across all statements or merge two predicates into one. Accessible from the graph page.

<h3 id="reckoning">Reckoning (STP)</h3>

Situation-Target-Proposal: describe your situation, state your goal, and the AI synthesizes options grounded ONLY in your confirmed triples. Every option cites its sources.

<h3 id="trust-system">Source Trust System</h3>

Sources accumulate trust scores based on your review decisions. Trusted sources can be auto-confirmed. A time-decay formula prevents stale trust from persisting.

<h3 id="ttl-export">Turtle Export</h3>

Export your graph as a .ttl file with full reification metadata (status, source, confidence, timestamps, excerpts). Roundtrip-safe. Clean export for interop or full export with all metadata.

<h3 id="why-it-matters">Why Reckons.AI Matters</h3>

In an era of information overload, Reckons.AI gives individuals a structured way to capture, verify, connect, and retrieve knowledge. It bridges the gap between human understanding and machine processing -- your knowledge becomes queryable, shareable, and portable.

## Related

- [The Semantic Triple](../triples-rdf/triple-architecture)
- [What Is Reckons.AI](../guide/what-is-reckons-ai)
