---
title: "Risk Warnings for Integrations"
slug: "risk-warnings"
order: 1011
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "Features with inherent risk are disabled by default and display a warning in Settings."
generated: "docs-kb"
---

# Risk Warnings for Integrations

*Concept*

Features with inherent risk are disabled by default and display a warning in Settings. Voice (Hume.AI): audio sent to cloud, warning shown. QR Mobile Access: token-based auth with expiry, warning shown. Cloud LLM backends: note text sent to third-party API, warning shown in backend selector. WASM local inference: transitive protobufjs CVE in dependency chain — models loaded only from HuggingFace CDN, no user data affected.
