---
title: "Integrations"
slug: "integrations"
order: 1009
section: "Integrations & Tech"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI connects to external tools and data sources while keeping your graph local."
generated: "docs-kb"
related:
  - "what-is-reckons-ai"
---

# Integrations

Reckons.AI connects to external tools and data sources while keeping your graph local. Every integration is optional -- the core app works with zero external dependencies.

## In this section

### Browser Extension

Manifest V3 extension with three tabs: Compare (page vs graph with at-a-glance bar), Session (multi-page research accumulation with aggregate summaries), Ingest (batch send to app). Supports Chrome, Firefox desktop, and Firefox for Android with mobile-optimized UI.

### Google Calendar

Import events as triples via OAuth. Dates, times, attendees, descriptions, and recurrence patterns become structured, queryable knowledge. Recurring events expanded with safety limits.

### Google Drive

Graph backup to Google Drive. Export .ttl to a dedicated Drive folder. OAuth-authenticated. Privacy note: Google can access the stored file.

### iCal (.ics) Import

Import any iCal feed -- Outlook, Apple Calendar, university schedules, conference programs. Events become triples with datetime extraction, recurrence detection, and conflict identification.

### Indico Events

Import scientific conference programs from Indico (CERN's event management system). Sessions, contributions, and speakers become structured triples.

### Kokoro TTS

Local text-to-speech using a cached 82MB model. Used for story walkthrough narration. Falls back to browser window.speechSynthesis. Voices cached in 'kokoro-voices' Cache API store.

**[MCP Server](../integrations-tech/mcp-server)**

Standalone Node.js MCP server exposing your graph to AI agents (Claude Desktop, Cursor, Claude Code).

### Meshy 3D Generation

Generate 3D GLB models for entities via the Meshy.ai API. Models are displayed as custom node shapes in the 3D graph view. Task status tracked via urn:kbase:meta/meshyTaskId statements.

### Model Cache Management

Inspect, sideload, and purge locally cached WASM models via Cache API. Manifests track SmolLM2-360M (370MB), MiniLM-L6-v2 (22MB), Kokoro 82M (88MB), Whisper Tiny (42MB). Service worker caches HuggingFace downloads with CacheFirst strategy.

**[n8n Cloud Sync](../integrations-tech/n8n-cloud-sync)**

Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS.

**[NVIDIA Cosmos3-Nano (Speculative)](../integrations-tech/cosmos3-nano)**

16B-parameter omnimodal world foundation model for Physical AI by NVIDIA.

**[NVIDIA NeMo Speech (Planned)](../integrations-tech/nemo-speech)**

GPU-accelerated STT and TTS via NVIDIA NeMo (Apache 2.0, open source, free).

**[Ollama (Local LLM Offload)](../integrations-tech/ollama)**

Local model server used two ways: as an in-app LLM backend (schema-constrained structured extraction, and prefer-local routing for chat/diff-summary/merge-analysis when reachable), and as an opt-in MCP bridge (kb_local_extract, kb_local_summarize, kb_generate_page) gated by OLLAMA_BASE_URL so the MCP server never depends on a local model unless you configure one.

### PDF / Image Import (Mistral OCR)

Upload PDFs or images. Mistral OCR extracts text, then the LLM extracts triples. Contracts, invoices, academic papers -- all become structured knowledge.

**[VS Code Extension (Planned)](../integrations-tech/vs-code-extension)**

Auto-inject graph into coding sessions via MCP bridge.

### Web Scraping (Jina / Firecrawl)

Extract content from URLs. Jina Reader for simple pages, Firecrawl for JavaScript-rendered sites. Content parsed into clean text, then LLM-extracted into triples.

### Whisper STT

Local speech-to-text via @huggingface/transformers using onnx-community/whisper-tiny (42MB quantized). Mic button in the chat tab. Runs entirely in-browser -- no cloud required.

### Workspace Folder Sync

Auto-exports knowledge.ttl to a local folder on each mutation. The MCP server reads this file. Pending notes arrive via knowledge.pending.jsonl. Can sync settings via save/load from folder.

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
