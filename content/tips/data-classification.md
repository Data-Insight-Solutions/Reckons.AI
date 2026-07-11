---
title: "Data Classification Levels"
slug: "data-classification"
order: 1003
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "All graph data stored in browser IndexedDB (origin-locked)."
generated: "docs-kb"
---

# Data Classification Levels

*Concept*

All graph data stored in browser IndexedDB (origin-locked). API keys stored in IndexedDB settings table (origin-locked, not in localStorage). sessionStorage for per-tab graph selection (not shared across origins). localStorage for graph registry (names and IDs only, no secrets). No cookies used. Keys sent directly from browser to provider APIs — never transit through Reckons.AI infrastructure. Keys excluded from TTL exports and settings profile exports.
