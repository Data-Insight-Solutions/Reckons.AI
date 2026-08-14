---
title: "Workspace TTL Naming Convention"
slug: "workspace-ttl-naming"
order: 1048
section: "Architecture"
parent: "workspace-folder-design"
template: doc
status: published
nav: sidebar
excerpt: "Each graph's Turtle file is named after its own folder — kbs/<name>/<name>.ttl — rather than a fixed kb.ttl inside each folder."
generated: "docs-kb"
---

# Workspace TTL Naming Convention

*Concept*

Each graph's Turtle file is named after its own folder — kbs/&lt;name&gt;/&lt;name&gt;.ttl — rather than a fixed kb.ttl inside each folder. Renaming a graph therefore renames both the directory and the file together, so `ls kbs/` is a legible index of every graph on disk and file managers/sync tools show meaningful names instead of a directory full of identically-named kb.ttl files. The reader still falls back to the legacy kbs/&lt;name&gt;/kb.ttl name (and migrates it to the new convention on next save) so older workspaces keep working.
