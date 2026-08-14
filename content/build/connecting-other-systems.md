---
title: "Connecting other systems"
slug: "connecting-other-systems"
order: 5
section: "Build"
template: doc
status: published
nav: sidebar
excerpt: "Bringing your own tools in and getting your knowledge back out. Every integration is optional."
generated: "docs-composed"
---

# Connecting other systems

Bringing your own tools in and getting your knowledge back out. Every integration is optional.

### @huggingface/transformers v3

Runs ML models in the browser via ONNX Runtime WebAssembly. Powers local LLM inference (Qwen2.5-0.5B-Instruct, q4 quantized), text embeddings (BGE-small-en-v1.5, q8, 384d, configurable), speech-to-text (Whisper Tiny), and text-to-speech (Kokoro 82M).

### Browser Extension

Manifest V3 extension with three tabs: Compare (page vs graph with at-a-glance bar), Session (multi-page research accumulation with aggregate summaries), Ingest (batch send to app). Supports Chrome, Firefox desktop, and Firefox for Android with mobile-optimized UI.

### Currents Monitor (n8n)

n8n workflow (workflow-id qb9uPZ8GScAmuUOX) extending the Source Monitor pattern for Currents: fetches enabled currents on a 30-minute schedule, respecting each current's own cadence via a due-check against its last-fetched time. RSS/Atom currents use the RSS Read node; URL-kind currents fetch-and-hash like Source Monitor. Items are deduplicated per (url, graph) before insert, so re-running the sweep never creates duplicate arrivals. Exposes a register webhook (upsert current definitions) and an items webhook (pull new rows for a graph, optionally since a timestamp) that the app polls to populate pod-view arrivals.

### Dexie.js + IndexedDB

Promise-based wrapper around IndexedDB. All graph data (statements, sources, changelog, settings) stored locally. Each graph is a separate Dexie database instance.

### Google Calendar

Import events as triples via OAuth. Dates, times, attendees, descriptions, and recurrence patterns become structured, queryable knowledge. Recurring events expanded with safety limits.

### Google Drive

Graph backup to Google Drive. Export .ttl to a dedicated Drive folder. OAuth-authenticated. Privacy note: Google can access the stored file.

### Graph Sync Hub (n8n)

n8n workflow gzL6AXn9iWo4GZxN with 4 webhook endpoints: POST /webhook/reckons-kb-upload (accepts JSON with kb_name and ttl_content, SHA-256 content-hash deduplication via upsert into reckons_kb_store data table), GET /webhook/reckons-kb-download?kb=name (serves text/turtle Content-Type), GET /webhook/reckons-kb-status (JSON summary of all stored graphs with names, hashes, and content lengths), GET /webhook/reckons-kb-pending?kb=name (pending notes from source monitors). Security: Header Auth credential on each webhook trigger node, pass token via Authorization header.

### iCal (.ics) Import

Import any iCal feed -- Outlook, Apple Calendar, university schedules, conference programs. Events become triples with datetime extraction, recurrence detection, and conflict identification.

### Indico Events

Import scientific conference programs from Indico (CERN's event management system). Sessions, contributions, and speakers become structured triples.

### Integrations

Reckons.AI connects to external tools and data sources while keeping your graph local. Every integration is optional -- the core app works with zero external dependencies.

See also: [Start here](/docs/learn/start-here)

### Kokoro TTS

Local text-to-speech using a cached 82MB model. Used for story walkthrough narration. Falls back to browser window.speechSynthesis. Voices cached in 'kokoro-voices' Cache API store.

### MCP Server

Standalone Node.js MCP server exposing your graph to AI agents (Claude Desktop, Cursor, Claude Code). 20 tools over JSON-RPC stdio: search and read (kb_search, kb_get_entity, kb_list_entities, kb_stats, kb_subgraph, kb_list_kbs, kb_compress), write proposals (kb_add_note), reasoning (kb_reckoning), source management (kb_list_sources, kb_request_refresh), git-aware alignment (kb_git_status, kb_check_plan, kb_pending, kb_git_diff_triples, kb_alignment_score), and the local Ollama bridge (kb_local_extract, kb_local_summarize, kb_generate_page, kb_entity_markdown). Reads workspace TTL files (kbs/&lt;name&gt;/&lt;name&gt;.ttl), with multi-Graph support via MultiKBReader.

### Meshy 3D Generation

Generate 3D GLB models for entities via the Meshy.ai API. Models are displayed as custom node shapes in the 3D graph view. Task status tracked via urn:kbase:meta/meshyTaskId statements.

### Model Cache Management

Inspect, sideload, and purge locally cached WASM models via Cache API. Manifests track SmolLM2-360M (370MB), MiniLM-L6-v2 (22MB), Kokoro 82M (88MB), Whisper Tiny (42MB). Service worker caches HuggingFace downloads with CacheFirst strategy.

### Model Context Protocol

An open protocol by Anthropic for connecting AI models to external data sources. Reckons.AI implements a standalone MCP server (Node.js) with 11 tools that reads workspace TTL files. Multi-Graph support via MultiKBReader.

### N3.js

JavaScript library for parsing and writing RDF (Turtle, N-Triples, N-Quads, TriG). Used for all .ttl import and export.

### n8n Cloud Sync

Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS. Two workflows: Graph Sync Hub (workflow gzL6AXn9iWo4GZxN — upload/download/status/pending via webhooks with SHA-256 content-hash deduplication) and Source Monitor (workflow CvbUNSZkZVf4hJFG — watches URLs every 6 hours, detects content changes via hash comparison, queues pending notes). Three data tables: reckons_kb_store (snapshots), reckons_watched_urls (monitored URLs), reckons_pending_notes (change notifications). Security via n8n Header Auth on webhook trigger nodes. No SaaS dependency — your n8n VPS is the cloud backend. Air-gapped operation supported.

### n8n Data Tables

Three n8n data tables back the cloud sync system. reckons_kb_store (ID: JgzUd876HO7ZAHNY) — Graph snapshots with columns: kb_name, content_hash (SHA-256), ttl_content (full Turtle text), uploaded_at (timestamp); uses content-hash upsert for deduplication. reckons_watched_urls (ID: JIsQ1QfsKkUAvMCh) — monitored URLs with columns: url, kb_name, content_hash (last known SHA-256), last_checked (timestamp). reckons_pending_notes (ID: irPqWecUHYIppq04) — change notifications with columns: kb_name, subject (URN derived from URL), predicate (e.g. source-content-changed), object_value (description with byte count and new hash), note (review instruction), status (pending/processed).

### NVIDIA Cosmos3-Nano (Speculative)

16B-parameter omnimodal world foundation model for Physical AI by NVIDIA. Generates and reasons over video, images, audio, and robot actions. OpenMDW 1.1 license (commercial use). Requires NVIDIA GPU (Ampere/Hopper/Blackwell) with BF16 precision, Linux only. Potential uses: generate preview animations from entity descriptions, multimodal graph ingest (video/image/audio sources), 3D scene understanding. Shares NVIDIA GPU sidecar infrastructure with NeMo Speech.

### NVIDIA NeMo Speech (Planned)

GPU-accelerated STT and TTS via NVIDIA NeMo (Apache 2.0, open source, free). Python sidecar or Docker container running alongside the app. STT: Nemotron-3.5-ASR-Streaming-0.6B (40 languages, controllable latency 80ms-1s, 5.63% WER). TTS: MagpieTTS v2602 (9 languages). Requires NVIDIA GPU + CUDA + Python 3.12+. Separate dev setup from the main SvelteKit app. HTTP API at localhost with /transcribe and /synthesize endpoints. Falls back to existing Whisper+Kokoro WASM for users without NVIDIA hardware.

### Ollama (Local LLM Offload)

Local model server used two ways: as an in-app LLM backend (schema-constrained structured extraction, and prefer-local routing for chat/diff-summary/merge-analysis when reachable), and as an opt-in MCP bridge (kb_local_extract, kb_local_summarize, kb_generate_page) gated by OLLAMA_BASE_URL so the MCP server never depends on a local model unless you configure one. All Ollama-backed output is proposal-only -- nothing is written to a graph without review.

### PDF / Image Import (Mistral OCR)

Upload PDFs or images. Mistral OCR extracts text, then the LLM extracts triples. Contracts, invoices, academic papers -- all become structured knowledge.

### Progressive Web App

Service worker (via @vite-pwa/sveltekit) enables offline access after first load. HuggingFace model downloads cached with CacheFirst strategy. Installable on desktop and mobile.

### shadcn-svelte

Copy-in component foundation (button, badge, card, separator, skeleton) generated by the shadcn-svelte CLI and mapped onto the existing Liquid design tokens (--accent, --surface, --rad, etc.).

### Source Monitor (n8n)

n8n workflow CvbUNSZkZVf4hJFG running on a 6-hour schedule trigger. Reads watched URLs from reckons_watched_urls data table, fetches each URL, computes SHA-256 content hash, compares against stored hash. Changed URLs produce pending notes written to reckons_pending_notes data table with subject (URN from URL), predicate (source-content-changed), object (byte count and new hash), and review note. Add URLs to watch via POST /webhook/reckons-watch-url with JSON body containing url and kb_name. Pending notes surface via the Sync Hub GET /webhook/reckons-kb-pending endpoint.

### SvelteKit 2 + Svelte 5

Web framework with adapter-static for fully client-side deployment. Svelte 5 runes ($state, $derived, $effect) for reactive state management.

### Tailwind CSS v4

Utility CSS engine, added as the foundation for shadcn-svelte components. Preflight (the base-element reset) is disabled so it layers onto the existing hand-rolled Liquid CSS instead of replacing it.

### Technology Stack

Static SvelteKit 2 app with Svelte 5 runes. Threlte/Three.js for 3D, N3.js for RDF parsing, @huggingface/transformers for embeddings and local LLM, Dexie for IndexedDB storage. No server required.

### Threlte 8 + Three.js

Svelte bindings for Three.js. Declarative 3D scene graph for the knowledge graph visualization. Canvas 2D fallback for low-end devices.

### VS Code Extension (Planned)

Auto-inject graph into coding sessions via MCP bridge. Wraps reckons-ai-mcp as child process with stdio transport. Phase 1: MCP bridge + auto-inject. Phase 2: live updates from editor actions. Phase 3: sidebar graph browser with webview graph. Zero config — activates when it detects kbs/*/*.ttl in workspace (legacy kbs/*/kb.ttl also recognized).

### Web Scraping (Jina / Firecrawl)

Extract content from URLs. Jina Reader for simple pages, Firecrawl for JavaScript-rendered sites. Content parsed into clean text, then LLM-extracted into triples.

### Whisper STT

Local speech-to-text via @huggingface/transformers using onnx-community/whisper-tiny (42MB quantized). Mic button in the chat tab. Runs entirely in-browser -- no cloud required.

### Workspace Folder Sync

Auto-exports knowledge.ttl to a local folder on each mutation. The MCP server reads this file. Pending notes arrive via knowledge.pending.jsonl. Can sync settings via save/load from folder.
