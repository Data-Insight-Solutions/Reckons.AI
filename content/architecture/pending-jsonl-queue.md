---
title: "Pending JSONL Queue"
slug: "pending-jsonl-queue"
order: 1030
section: "Architecture"
parent: "workspace-folder-design"
template: doc
status: published
nav: sidebar
excerpt: "Append-only JSONL file (pending.jsonl) serves as message queue between MCP server/CLI tools and the web app."
generated: "docs-kb"
---

# Pending JSONL Queue

*Concept*

Append-only JSONL file (pending.jsonl) serves as message queue between MCP server/CLI tools and the web app. Entries carry subject, predicate, object, type, priority, agent, commitSha metadata. Web app drains on load or manual trigger, converts to pending statements for human review, then clears the file. JSONL chosen over TTL for this role because: atomic line-append is safe for concurrent writes, rich metadata is native JSON, parse cost is trivial, drain-and-clear is a queue pattern not a knowledge pattern.
