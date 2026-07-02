---
title: "Local-First Architecture"
slug: "local-first-arch"
order: 1018
section: "Architecture"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "All user data lives in browser IndexedDB (Dexie v4)."
generated: "docs-kb"
---

# Local-First Architecture

*Concept*

All user data lives in browser IndexedDB (Dexie v4). No server, no accounts, no cloud dependency. The app is a static SvelteKit build. Export to .ttl for portability. Workspace folder sync for disk backup and MCP server access.
