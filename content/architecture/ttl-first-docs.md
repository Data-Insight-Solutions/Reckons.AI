---
title: "TTL-First Documentation"
slug: "ttl-first-docs"
order: 1040
section: "Architecture"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI uses its own TTL knowledge bases as the primary documentation format."
generated: "docs-kb"
related:
  - "ttl-vs-markdown-gaps"
---

# TTL-First Documentation

*Concept*

Reckons.AI uses its own TTL knowledge bases as the primary documentation format. Claude Code queries KBs via MCP tools (kb_search, kb_get_entity, kb_compress) instead of reading markdown files. This dogfoods the product and proves that structured knowledge graphs can replace prose documentation for AI-assisted development.

## Related

**Related**

- [TTL vs Markdown Gap Analysis](../architecture/ttl-vs-markdown-gaps)
