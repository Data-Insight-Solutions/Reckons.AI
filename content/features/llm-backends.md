---
title: "LLM Backends"
slug: "llm-backends"
order: 1017
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "9 providers: Claude, OpenAI, Gemini, Ollama (local), OpenRouter (free tier), WASM (offline, Qwen2.5-0.5B-Instruct), Chrome AI (Gemini Nano), Manual paste, Mock."
generated: "docs-kb"
---

# LLM Backends

9 providers: Claude, OpenAI, Gemini, Ollama (local), OpenRouter (free tier), WASM (offline, Qwen2.5-0.5B-Instruct), Chrome AI (Gemini Nano), Manual paste, Mock. Per-task backend overrides let you use different providers for ingest, chat, analysis, diff summary, and merge analysis. Prefer-local routing can redirect chat, diff summary, and merge analysis to a reachable local Ollama server.

<p class="derived">It has 2 parts below.</p>

## In this section

### Model Cache Management

Inspect, sideload, and purge locally cached WASM models. Manifests for Qwen2.5-0.5B (500MB), BGE-small-en-v1.5 (33MB), MiniLM-L6-v2 (22MB), Kokoro 82M (88MB), Whisper Tiny (42MB). Settings &gt; Integrations &gt; local model cache.

**[Prefer-Local Routing](../features/prefer-local)**

Opt-in setting that redirects chat, diff-summary, and merge-analysis to a local Ollama model whenever it is reachable, instead of your chosen cloud backend.
