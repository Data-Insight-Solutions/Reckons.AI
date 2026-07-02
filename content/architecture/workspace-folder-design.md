---
title: "Workspace Folder Design"
slug: "workspace-folder-design"
order: 1043
section: "Architecture"
parent: "local-first-arch"
template: doc
status: published
nav: sidebar
excerpt: "User-selected directory via File System Access API (Chrome/Edge only)."
generated: "docs-kb"
related:
  - "multi-kb"
---

# Workspace Folder Design

*Concept*

User-selected directory via File System Access API (Chrome/Edge only). Structure: knowledge.ttl (legacy single-KB), kbs/{String.fromCharCode(123)}name{String.fromCharCode(125)}/{String.fromCharCode(123)}name{String.fromCharCode(125)}.ttl + meta.json + sources.json (multi-KB; legacy kb.ttl still read as a fallback), knowledge.pending.jsonl (MCP inbox), settings_profile.json. Auto-exports on every KB mutation (2s debounce).

## Related

**Related**

- [Multi-KB Management](../features/multi-kb)
