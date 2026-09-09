---
title: "Integrations"
slug: "integrations"
order: 70
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

<p class="derived">It has 18 parts below.</p>

## In this section

### What it can do

<div class="card-grid">

<a class="card" href="#browser-extension"><span class="card-title">Browser Extension</span><span class="card-text">Manifest V3 extension with three tabs: Compare (page vs graph with at-a-glance bar), Session (multi-page research accumulation with aggregate summaries), Ingest (batch send to app).</span></a>
<a class="card" href="#google-calendar"><span class="card-title">Google Calendar</span><span class="card-text">Import events as triples via OAuth.</span></a>
<a class="card" href="#google-drive"><span class="card-title">Google Drive</span><span class="card-text">Graph backup to Google Drive.</span></a>
<a class="card" href="#i-cal-feed"><span class="card-title">iCal (.ics) Import</span><span class="card-text">Import any iCal feed -- Outlook, Apple Calendar, university schedules, conference programs.</span></a>
<a class="card" href="#indico-events"><span class="card-title">Indico Events</span><span class="card-text">Import scientific conference programs from Indico (CERN's event management system).</span></a>
<a class="card" href="../integrations-tech/mcp-server"><span class="card-title">MCP Server</span><span class="card-text">Standalone Node.js MCP server exposing your graph to AI agents (Claude Desktop, Cursor, Claude Code).</span></a>
<a class="card" href="#model-cache-integrations-tech"><span class="card-title">Model Cache Management</span><span class="card-text">Inspect, sideload, and purge locally cached WASM models via Cache API.</span></a>
<a class="card" href="../integrations-tech/n8n-cloud-sync"><span class="card-title">n8n Cloud Sync</span><span class="card-text">Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS.</span></a>
<a class="card" href="#pdf-import"><span class="card-title">PDF / Image Import (Mistral OCR)</span><span class="card-text">Upload PDFs or images.</span></a>
<a class="card" href="../integrations-tech/vs-code-extension"><span class="card-title">VS Code Extension (Planned)</span><span class="card-text">Auto-inject graph into coding sessions via MCP bridge.</span></a>
<a class="card" href="#web-scraping"><span class="card-title">Web Scraping (Jina / Firecrawl)</span><span class="card-text">Extract content from URLs.</span></a>
<a class="card" href="#workspace-sync"><span class="card-title">Workspace Folder Sync</span><span class="card-text">Auto-exports knowledge.ttl to a local folder on each mutation.</span></a>

</div>

### Tool

<div class="card-grid">

<a class="card" href="#kokoro-tts-integrations-tech"><span class="card-title">Kokoro TTS</span><span class="card-text">Local text-to-speech using a cached 82MB model.</span></a>
<a class="card" href="#meshy3-d"><span class="card-title">Meshy 3D Generation</span><span class="card-text">Generate 3D GLB models for entities via the Meshy.ai API.</span></a>
<a class="card" href="../integrations-tech/cosmos3-nano"><span class="card-title">NVIDIA Cosmos3-Nano (Speculative)</span><span class="card-text">16B-parameter omnimodal world foundation model for Physical AI by NVIDIA.</span></a>
<a class="card" href="../integrations-tech/nemo-speech"><span class="card-title">NVIDIA NeMo Speech (Planned)</span><span class="card-text">GPU-accelerated STT and TTS via NVIDIA NeMo (Apache 2.0, open source, free).</span></a>
<a class="card" href="../integrations-tech/ollama"><span class="card-title">Ollama (Local LLM Offload)</span><span class="card-text">Local model server used two ways: as an in-app LLM backend (schema-constrained structured extraction, and prefer-local routing for chat/diff-summary/merge-analysis when reachable), and as an opt-in MCP bridge (kb_local_extract, kb_local_summarize, kb_generate_page) gated by OLLAMA_BASE_URL so the MCP server never depends on a local model unless you configure one.</span></a>
<a class="card" href="#whisper-stt-integrations-tech"><span class="card-title">Whisper STT</span><span class="card-text">Local speech-to-text via @huggingface/transformers using onnx-community/whisper-tiny (42MB quantized).</span></a>

</div>

<h3 id="browser-extension">Browser Extension</h3>

Manifest V3 extension with three tabs: Compare (page vs graph with at-a-glance bar), Session (multi-page research accumulation with aggregate summaries), Ingest (batch send to app). Supports Chrome, Firefox desktop, and Firefox for Android with mobile-optimized UI.

<h3 id="google-calendar">Google Calendar</h3>

Import events as triples via OAuth. Dates, times, attendees, descriptions, and recurrence patterns become structured, queryable knowledge. Recurring events expanded with safety limits.

<h3 id="google-drive">Google Drive</h3>

Graph backup to Google Drive. Export .ttl to a dedicated Drive folder. OAuth-authenticated. Privacy note: Google can access the stored file.

<h3 id="i-cal-feed">iCal (.ics) Import</h3>

Import any iCal feed -- Outlook, Apple Calendar, university schedules, conference programs. Events become triples with datetime extraction, recurrence detection, and conflict identification.

<h3 id="indico-events">Indico Events</h3>

Import scientific conference programs from Indico (CERN's event management system). Sessions, contributions, and speakers become structured triples.

<h3 id="model-cache-integrations-tech">Model Cache Management</h3>

Inspect, sideload, and purge locally cached WASM models via Cache API. Manifests track SmolLM2-360M (370MB), MiniLM-L6-v2 (22MB), Kokoro 82M (88MB), Whisper Tiny (42MB). Service worker caches HuggingFace downloads with CacheFirst strategy.

<h3 id="pdf-import">PDF / Image Import (Mistral OCR)</h3>

Upload PDFs or images. Mistral OCR extracts text, then the LLM extracts triples. Contracts, invoices, academic papers -- all become structured knowledge.

<h3 id="web-scraping">Web Scraping (Jina / Firecrawl)</h3>

Extract content from URLs. Jina Reader for simple pages, Firecrawl for JavaScript-rendered sites. Content parsed into clean text, then LLM-extracted into triples.

<h3 id="workspace-sync">Workspace Folder Sync</h3>

Auto-exports knowledge.ttl to a local folder on each mutation. The MCP server reads this file. Pending notes arrive via knowledge.pending.jsonl. Can sync settings via save/load from folder.

<h3 id="kokoro-tts-integrations-tech">Kokoro TTS</h3>

Local text-to-speech using a cached 82MB model. Used for story walkthrough narration. Falls back to browser window.speechSynthesis. Voices cached in 'kokoro-voices' Cache API store.

<h3 id="meshy3-d">Meshy 3D Generation</h3>

Generate 3D GLB models for entities via the Meshy.ai API. Models are displayed as custom node shapes in the 3D graph view. Task status tracked via urn:kbase:meta/meshyTaskId statements.

<h3 id="whisper-stt-integrations-tech">Whisper STT</h3>

Local speech-to-text via @huggingface/transformers using onnx-community/whisper-tiny (42MB quantized). Mic button in the chat tab. Runs entirely in-browser -- no cloud required.

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
