---
title: "Shelly (AI Assistant)"
slug: "shelly"
order: 1031
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "The turtle-shaped AI assistant."
generated: "docs-kb"
---

# Shelly (AI Assistant)

The turtle-shaped AI assistant. Three tabs: tutorial, chat (grounded in your graph), and explore (guided story tours). Each graph can embed its own Shelly persona via the shelly: vocabulary. Supports Whisper STT voice input and Kokoro TTS voice output.

<p class="derived">It has 4 parts below.</p>

<p class="in-sets">Part of Ask it things.</p>

## In this section

### Kokoro TTS

Local text-to-speech for story walkthroughs. 82M model cached in browser. Falls back to browser speech synthesis if unavailable.

### Persona System

Each graph can embed its own AI assistant personality using the shelly: vocabulary. A work graph might have a direct, technical persona while a personal graph has a calm guide. Persona travels with the .ttl file.

### Story System

Guided walkthroughs defined as triples using the story: vocabulary. Steps can highlight entities, trigger prompts, and pose questions. Playback with countdown timer and TTS. Shareable via .ttl files.

### Whisper STT

Local speech-to-text via transformers.js using whisper-tiny (42MB). Mic button in the chat tab. Runs entirely in-browser -- no cloud, no API key.

## Related

- [Shelly (AI Assistant)](../features/shelly)
- [Shelly (AI Assistant)](../features/shelly)
