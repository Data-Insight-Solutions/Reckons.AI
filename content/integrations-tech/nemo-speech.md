---
title: "NVIDIA NeMo Speech (Planned)"
slug: "nemo-speech"
order: 1019
section: "Integrations & Tech"
parent: "integrations"
template: doc
status: published
nav: sidebar
excerpt: "GPU-accelerated STT and TTS via NVIDIA NeMo (Apache 2.0, open source, free)."
generated: "docs-kb"
related:
  - "kokoro-tts-integrations-tech"
  - "whisper-stt-integrations-tech"
---

# NVIDIA NeMo Speech (Planned)

*Tool*

GPU-accelerated STT and TTS via NVIDIA NeMo (Apache 2.0, open source, free). Python sidecar or Docker container running alongside the app. STT: Nemotron-3.5-ASR-Streaming-0.6B (40 languages, controllable latency 80ms-1s, 5.63% WER). TTS: MagpieTTS v2602 (9 languages). Requires NVIDIA GPU + CUDA + Python 3.12+. Separate dev setup from the main SvelteKit app. HTTP API at localhost with /transcribe and /synthesize endpoints. Falls back to existing Whisper+Kokoro WASM for users without NVIDIA hardware.

## Related

**Related**

- [Kokoro TTS](../integrations-tech/kokoro-tts-integrations-tech)
- [Whisper STT](../integrations-tech/whisper-stt-integrations-tech)
