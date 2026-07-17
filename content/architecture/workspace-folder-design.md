---
title: "Workspace Folder Design"
slug: "workspace-folder-design"
order: 1047
section: "Architecture"
parent: "local-first-arch"
template: doc
status: published
nav: sidebar
excerpt: "User-selected directory via File System Access API (Chrome/Edge only)."
generated: "docs-kb"
related:
  - "multi-kb"
  - "workspace-ttl-naming"
---

# Workspace Folder Design

*Concept*

User-selected directory via File System Access API (Chrome/Edge only). Structure: knowledge.ttl (legacy single-Graph), kbs/{String.fromCharCode(123)}name{String.fromCharCode(125)}/{String.fromCharCode(123)}name{String.fromCharCode(125)}.ttl + meta.json (multi-Graph; legacy kbs/{String.fromCharCode(123)}name{String.fromCharCode(125)}/kb.ttl still read as a fallback), knowledge.pending.jsonl (MCP inbox), settings_profile.json. Auto-exports on every graph mutation (2s debounce). sources.json was removed: it was written on export but never consumed on import, so it added disk writes without a reader.

## Related

**Related**

- [Multi-Graph Management](../features/multi-kb)
- [Workspace TTL Naming Convention](../architecture/workspace-ttl-naming)
