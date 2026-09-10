---
title: "TTL-First Documentation"
slug: "ttl-first-docs"
order: 1043
section: "Architecture"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI uses its own TTL knowledge graphs as the primary documentation format."
generated: "docs-kb"
related:
  - "ttl-vs-markdown-gaps"
---

# TTL-First Documentation

Reckons.AI uses its own TTL knowledge graphs as the primary documentation format. Claude Code queries graphs via MCP tools (kb_search, kb_get_entity, kb_compress) instead of reading markdown files. This dogfoods the product and proves that structured knowledge graphs can replace prose documentation for AI-assisted development.

<p class="derived">It has 4 parts below.</p>

## In this section

**[TTL vs Markdown Gap Analysis](../architecture/ttl-vs-markdown-gaps)**

Ongoing evaluation of what TTL handles well vs where markdown is still needed.

**[Graph Is Source of Truth (Docs Pipeline)](../architecture/graph-is-source-of-truth)**

The docs TTL knowledge graphs (static/*.ttl) are the canonical source for the published /docs site, not the other way around: scripts/docs-pages.ts reads the docs graphs and generates content/*.md, which SvelteKit prerenders.

**[Markdown Migration Status](../architecture/migration-status)**

Tracking which markdown docs have been migrated to TTL graphs.

**[Minimal CLAUDE.md Pattern](../architecture/claude-md-minimal)**

Keep CLAUDE.md as small as possible — only hard constraints (file format rules, test commands, key directories) and MCP instructions.

## Related

- [TTL vs Markdown Gap Analysis](../architecture/ttl-vs-markdown-gaps)
