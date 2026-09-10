---
title: "TTL vs Markdown Gap Analysis"
slug: "ttl-vs-markdown-gaps"
order: 100
section: "Architecture"
parent: "ttl-first-docs"
template: doc
status: published
nav: sidebar
excerpt: "Ongoing evaluation of what TTL handles well vs where markdown is still needed."
generated: "docs-kb"
---

# TTL vs Markdown Gap Analysis

Ongoing evaluation of what TTL handles well vs where markdown is still needed. Key gaps: procedural sequences (step-by-step), code block formatting, ASCII diagrams, long-form rationale prose. Key advantages: MCP queryability, cross-Graph linking, type system, semantic diff, compression (a relevant subgraph instead of the whole graph; the compact encoding adds ~18% on top — measured), graph visualization.

<p class="derived">It has 8 parts below.</p>

## In this section

### Advantage: Graph Visualization

TTL docs load into the app as interactive 3D/2D knowledge graphs. Navigate visually. See relationships. This is impossible with markdown — it is the product demonstrating itself.

**[Advantage: MCP Queryability](../architecture/ttl-advantage-query)**

kb_search finds relevant entities across all graphs with a single query.

### Advantage: Semantic Linking

Entities link via skos:related, skos:broader, skos:narrower. A feature entity connects to its roadmap status, its design decisions, its integration dependencies. Markdown cross-references are just hyperlinks with no semantic meaning.

### Files That Must Stay Markdown

CLAUDE.md (Claude Code system file, always loaded into context), MEMORY.md (auto-memory system file), .claude/commands/*.md (slash command definitions), README.md (GitHub convention, npm ecosystem), CONTRIBUTING.md (GitHub convention). These are consumed by tools that require markdown format.

### Gap: Code Block Formatting

CSS variable tables, TypeScript patterns, shell commands lose syntax highlighting in TTL string literals. Mitigation: keep code conventions as inline code comments near the actual code. Use TTL for the conceptual summary (what the convention IS), not the literal code.

### Gap: Discovery Without Prior Knowledge

Markdown: Glob docs/*.md shows all docs. TTL via MCP: must know what to search for. Mitigation: kb_list_entities gives full entity list, kb_stats gives overview, CLAUDE.md lists which graphs exist and their purpose. The hub TTL (starter-guide.ttl) provides a table of contents.

### Gap: Full Context Loading

Reading a markdown file puts full content in context. MCP kb_search returns BM25 results — good for targeted queries, incomplete for broad understanding. Mitigation: kb_compress gives a budget-capped summary, kb_subgraph gives entity neighborhood, reading the TTL file directly is always possible as fallback.

### Gap: Procedural Sequences

Step-by-step instructions (install X, then configure Y, then run Z) are awkward as triples. Mitigation: use skos:note for numbered steps within an entity, or use plain-text comments in TTL files. For setup/install guides, keep as README.md or inline code comments.
