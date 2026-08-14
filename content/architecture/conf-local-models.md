---
title: "Local Model Recommendations"
slug: "conf-local-models"
order: 1018
section: "Architecture"
parent: "mig-confluence-design"
template: doc
status: published
nav: sidebar
excerpt: "Recommended: gemma3:12b via Ollama for migration."
generated: "docs-kb"
---

# Local Model Recommendations

*Concept*

Recommended: gemma3:12b via Ollama for migration. Handles structured extraction well, 128K context, ~15 tokens/sec on consumer GPU. For 500 pages with 3 chunks average, ~1,500 LLM calls, approximately 2-4 hours. Alternatives: gemma3:4b (fast, good for &lt;100 pages), gemma3:27b (excellent quality, slow), qwen3:8b (good alternative), llama3.2:3b (very fast, acceptable quality). WASM fallback (Qwen2.5-0.5B) for small spaces &lt;50 pages where user reviews every triple.
