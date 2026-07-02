---
title: "Mobile Voice Capture (Design)"
slug: "mobile-voice-capture"
order: 1023
section: "Architecture"
parent: "mobile-access"
template: doc
status: published
nav: sidebar
excerpt: "Planned: async voice memo capture on iOS/Android via n8n webhook."
generated: "docs-kb"
---

# Mobile Voice Capture (Design)

*Concept*

Planned: async voice memo capture on iOS/Android via n8n webhook. Record memo → n8n receives audio → Whisper transcription → extract triples → write to pending.jsonl → appears in review queue on next app load. No mobile app required — uses native voice recorder + Shortcuts/Tasker to POST to webhook.

## Details

**Status**

- planned
