---
title: "TTL vs Markdown Gap Analysis"
slug: "ttl-vs-markdown-gaps"
order: 1043
section: "Architecture"
parent: "ttl-first-docs"
template: doc
status: published
nav: sidebar
excerpt: "Ongoing evaluation of what TTL handles well vs where markdown is still needed."
generated: "docs-kb"
---

# TTL vs Markdown Gap Analysis

*Concept*

Ongoing evaluation of what TTL handles well vs where markdown is still needed. Key gaps: procedural sequences (step-by-step), code block formatting, ASCII diagrams, long-form rationale prose. Key advantages: MCP queryability, cross-Graph linking, type system, semantic diff, compression (a relevant subgraph instead of the whole graph; the compact encoding adds ~18% on top — measured), graph visualization.

## Steps

**[Advantage: Graph Visualization](../architecture/ttl-advantage-visualization)**

TTL docs load into the app as interactive 3D/2D knowledge graphs.

**[Advantage: MCP Queryability](../architecture/ttl-advantage-query)**

kb_search finds relevant entities across all graphs with a single query.

**[Advantage: Semantic Linking](../architecture/ttl-advantage-linking)**

Entities link via skos:related, skos:broader, skos:narrower.

**[Files That Must Stay Markdown](../architecture/must-stay-markdown)**

CLAUDE.md (Claude Code system file, always loaded into context), MEMORY.md (auto-memory system file), .claude/commands/*.md (slash command definitions), README.md (GitHub convention, npm ecosystem), CONTRIBUTING.md (GitHub convention).

**[Gap: Code Block Formatting](../architecture/ttl-gap-code-blocks)**

CSS variable tables, TypeScript patterns, shell commands lose syntax highlighting in TTL string literals.

**[Gap: Discovery Without Prior Knowledge](../architecture/ttl-gap-discovery)**

Markdown: Glob docs/*.md shows all docs.

**[Gap: Full Context Loading](../architecture/ttl-gap-context-loading)**

Reading a markdown file puts full content in context.

**[Gap: Procedural Sequences](../architecture/ttl-gap-procedural)**

Step-by-step instructions (install X, then configure Y, then run Z) are awkward as triples.
