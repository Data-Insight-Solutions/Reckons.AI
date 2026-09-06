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

*Concept*

Reckons.AI connects to external tools and data sources while keeping your graph local. Every integration is optional -- the core app works with zero external dependencies.

## Where to go next

**[Browser Extension](../integrations-tech/browser-extension)**

Manifest V3 extension with three tabs: Compare (page vs graph with at-a-glance bar), Session (multi-page research accumulation with aggregate summaries), Ingest (batch send to app).

**[Google Calendar](../integrations-tech/google-calendar)**

Import events as triples via OAuth.

**[Google Drive](../integrations-tech/google-drive)**

Graph backup to Google Drive.

**[iCal (.ics) Import](../integrations-tech/i-cal-feed)**

Import any iCal feed -- Outlook, Apple Calendar, university schedules, conference programs.

**[Indico Events](../integrations-tech/indico-events)**

Import scientific conference programs from Indico (CERN's event management system).

**[Kokoro TTS](../integrations-tech/kokoro-tts-integrations-tech)**

Local text-to-speech using a cached 82MB model.

**[MCP Server](../integrations-tech/mcp-server)**

Standalone Node.js MCP server exposing your graph to AI agents (Claude Desktop, Cursor, Claude Code).

**[Meshy 3D Generation](../integrations-tech/meshy3-d)**

Generate 3D GLB models for entities via the Meshy.ai API.

**[Model Cache Management](../integrations-tech/model-cache-integrations-tech)**

Inspect, sideload, and purge locally cached WASM models via Cache API.

**[n8n Cloud Sync](../integrations-tech/n8n-cloud-sync)**

Private, self-hosted cloud sync via n8n workflow automation on a self-hosted VPS.

**[NVIDIA Cosmos3-Nano (Speculative)](../integrations-tech/cosmos3-nano)**

16B-parameter omnimodal world foundation model for Physical AI by NVIDIA.

**[NVIDIA NeMo Speech (Planned)](../integrations-tech/nemo-speech)**

GPU-accelerated STT and TTS via NVIDIA NeMo (Apache 2.0, open source, free).

**[Ollama (Local LLM Offload)](../integrations-tech/ollama)**

Local model server used two ways: as an in-app LLM backend (schema-constrained structured extraction, and prefer-local routing for chat/diff-summary/merge-analysis when reachable), and as an opt-in MCP bridge (kb_local_extract, kb_local_summarize, kb_generate_page) gated by OLLAMA_BASE_URL so the MCP server never depends on a local model unless you configure one.

**[PDF / Image Import (Mistral OCR)](../integrations-tech/pdf-import)**

Upload PDFs or images.

**[VS Code Extension (Planned)](../integrations-tech/vs-code-extension)**

Auto-inject graph into coding sessions via MCP bridge.

**[Web Scraping (Jina / Firecrawl)](../integrations-tech/web-scraping)**

Extract content from URLs.

**[Whisper STT](../integrations-tech/whisper-stt-integrations-tech)**

Local speech-to-text via @huggingface/transformers using onnx-community/whisper-tiny (42MB quantized).

**[Workspace Folder Sync](../integrations-tech/workspace-sync)**

Auto-exports knowledge.ttl to a local folder on each mutation.

## Related

**Related**

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
