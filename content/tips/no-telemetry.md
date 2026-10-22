---
title: "Privacy and Network Boundaries"
slug: "no-telemetry"
order: 1009
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "Local storage does not mean zero network activity."
generated: "docs-kb"
---

# Privacy and Network Boundaries

Local storage does not mean zero network activity. The core app stores graphs and settings in the browser and has no required Reckons.AI account or general app backend. Cloud AI requests send task content and relevant facts to the configured provider, with credentials used to authenticate requests. URL ingestion uses Jina Reader or a configured scraper; remote OCR sends documents or images to its provider. Enabled Drive or n8n sync can transfer graphs in the background. Sharing, publishing, and connected MCP clients also cross the local-storage boundary. On-device inference avoids sending inference inputs to a remote model, but model assets must first be downloaded or sideloaded, and an Ollama endpoint can itself be remote. Prefer-local routing can fall back to the configured provider; it is not an offline lock. The hosted site permits Cloudflare Web Analytics for visit and performance measurement: src/app.html allows its script and reporting origin, while injection and route coverage depend on hosting configuration. A static build alone does not prove that analytics excludes app routes or that third parties receive no data. This documentation does not claim a deployment-wide network or telemetry audit. Review your provider, per-task, sync and integration settings before using sensitive material.
