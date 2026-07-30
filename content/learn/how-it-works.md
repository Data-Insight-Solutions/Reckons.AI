---
title: "How it works"
slug: "how-it-works"
order: 3
section: "Learn"
template: doc
status: published
nav: sidebar
excerpt: "Triples, graphs and the design decisions behind them — why the data is shaped this way."
generated: "docs-composed"
---

# How it works

Triples, graphs and the design decisions behind them — why the data is shaped this way.

## Architecture

### Advantage: Graph Visualization

TTL docs load into the app as interactive 3D/2D knowledge graphs. Navigate visually. See relationships. This is impossible with markdown — it is the product demonstrating itself.

### Advantage: MCP Queryability

kb_search finds relevant entities across all graphs with a single query. No need to know which file to read. kb_compress cuts the tokens you feed an LLM, mostly by SELECTING a relevant subgraph rather than handing over the whole graph (the compact encoding itself is worth a further ~18% — measured, not estimated). kb_reckoning gives grounded STP analysis. This is fundamentally better than reading 15 markdown files.

### Advantage: Semantic Linking

Entities link via skos:related, skos:broader, skos:narrower. A feature entity connects to its roadmap status, its design decisions, its integration dependencies. Markdown cross-references are just hyperlinks with no semantic meaning.

### Currents Settings as Meta Triples

Per-graph currents configuration (allowed entity types, per-current source/cadence/label) lives IN the graph as ordinary statements under the urn:reckons:meta/currents/ namespace, the same pattern used by nav:order for hierarchy. This means settings travel with TTL export/import and are visible to MCP tools without a separate settings store. isMetaPredicate hides the whole namespace from the rendered graph edges so it does not clutter the visualization.

### Dependency Health

Core deps: svelte 5, sveltekit 2, dexie 4, n3 1.x, three 0.169, @huggingface/transformers 3.x, bits-ui 2.x, fflate 0.8. Dev deps: vitest 4.x, playwright 1.x, typescript 5.x. All deps actively maintained. No abandoned packages. Browser-only runtime — no server deps in production.

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

### Graph Is Source of Truth (Docs Pipeline)

The docs TTL knowledge graphs (static/*.ttl) are the canonical source for the published /docs site, not the other way around: scripts/docs-pages.ts reads the docs graphs and generates content/*.md, which SvelteKit prerenders. There is deliberately NO markdown-to-TTL back-propagation (decided 2026-07-03): graph edits happen in the app or directly on the TTL files, the Sveltia CMS admin UI is only for non-generated content, and hand-edits to generated pages are overwritten by the next regeneration by design. scripts/md-align.ts (built on the site-import round-trip) flags generated pages that have drifted from their graph, so accidental hand-edits are caught rather than silently absorbed.

### Local-First Architecture

All user data lives in browser IndexedDB (Dexie v4). No server, no accounts, no cloud dependency. The app is a static SvelteKit build. Export to .ttl for portability. Workspace folder sync for disk backup and MCP server access.

### Markdown Migration Status

Tracking which markdown docs have been migrated to TTL graphs. Goal: eliminate all docs/*.md files except where markdown format is structurally required (GitHub conventions, Claude Code system files).

### Minimal CLAUDE.md Pattern

Keep CLAUDE.md as small as possible — only hard constraints (file format rules, test commands, key directories) and MCP instructions. All feature docs, roadmap, architecture, and design decisions live in TTL graphs. CLAUDE.md tells Claude HOW to find information (use kb_search), not what the information IS.

### Mobile Access via Local Server

Run Reckons.AI on a Linux machine with Ollama, access from mobile via LAN. Requires: Vite dev server bound to 0.0.0.0, Ollama OLLAMA_HOST=0.0.0.0, optional self-signed SSL for HTTPS. QR code generation built into settings page. PWA installable on mobile after first visit.

### Mobile Voice Capture (Design)

Planned: async voice memo capture on iOS/Android via n8n webhook. Record memo → n8n receives audio → Whisper transcription → extract triples → write to pending.jsonl → appears in review queue on next app load. No mobile app required — uses native voice recorder + Shortcuts/Tasker to POST to webhook.

### Pending JSONL Queue

Append-only JSONL file (pending.jsonl) serves as message queue between MCP server/CLI tools and the web app. Entries carry subject, predicate, object, type, priority, agent, commitSha metadata. Web app drains on load or manual trigger, converts to pending statements for human review, then clears the file. JSONL chosen over TTL for this role because: atomic line-append is safe for concurrent writes, rich metadata is native JSON, parse cost is trivial, drain-and-clear is a queue pattern not a knowledge pattern.

### PROV-O Alignment

Partial alignment with W3C PROV-O ontology. Source provenance tracked via custom urn:kbase:meta/ predicates (source, ingestedAt, confidence, excerpt). Full prov:Activity chains not implemented — unnecessary complexity for a personal graph where the user IS the reviewing agent. Custom namespace chosen for simplicity and smaller TTL output.

### RDF Vocabulary Decisions

Standard: rdf:type, rdfs:label, skos:definition, skos:broader, skos:related, skos:note. Custom: urn:kbase:type/ (entity types), urn:kbase:predicate/ (user predicates), urn:kbase:meta/ (reification metadata: status, source, confidence, excerpt, timestamps). urn:reckons: namespace for product-specific vocab (leap, shelly, feature).

### Schema-Constrained Local Extraction

Small local models (via Ollama) are unreliable at freeform triple extraction, so the local extraction path constrains the model to a fixed JSON schema (subject/predicate/object/type fields) with a compact prompt rather than the richer freeform prompt used for cloud backends. This trades some extraction nuance for reliability: schema-constrained output parses deterministically even from a 1-4B parameter model, where freeform JSON from the same model frequently fails to parse. Structured output is still treated as ordinary pending proposals — nothing bypasses review.

### Static Deployment

SvelteKit adapter-static produces a pure client-side build. No server-side runtime in production. Deployable to any static host (Netlify, Vercel, GitHub Pages, local file server). Vite dev server provides HMR during development only.

### Style Conventions

Brand: dark theme, accent #7dd3fc (sky-300). Fonts: Bespoke Stencil Bold (display), Supreme Regular (body/mono), self-hosted (no Google Fonts). CSS variables: --accent, --accent-soft, --data, --surface, --surface-2, --surface-3, --line, --muted, --font-mono, --font-display, --rad, --rad-sm, --rad-lg. Z-index scale: node-labels=10, panels=300, Shelly=350, SearchBar=390, NavBar=400, MergeReview=500. bits-ui components always use :global(.class) for CSS targeting.

### Tailwind-Without-Preflight Containment

shadcn-svelte components are introduced on Tailwind v4 with Tailwind's CSS reset (preflight) disabled. Preflight would rewrite base element styles (margins, headings, form controls) across the whole app and collide with the existing hand-rolled Liquid CSS. Disabling it lets Tailwind utility classes and the new components layer on top of, rather than replace, the current design language. Component-level tokens map onto the existing CSS variables (--accent, --surface, --rad, etc.) documented in arch:StyleConventions, so new shadcn components pick up the same theme automatically.

### TTL vs Markdown Gap Analysis

Ongoing evaluation of what TTL handles well vs where markdown is still needed. Key gaps: procedural sequences (step-by-step), code block formatting, ASCII diagrams, long-form rationale prose. Key advantages: MCP queryability, cross-Graph linking, type system, semantic diff, compression (a relevant subgraph instead of the whole graph; the compact encoding adds ~18% on top — measured), graph visualization.

### TTL-First Documentation

Reckons.AI uses its own TTL knowledge graphs as the primary documentation format. Claude Code queries graphs via MCP tools (kb_search, kb_get_entity, kb_compress) instead of reading markdown files. This dogfoods the product and proves that structured knowledge graphs can replace prose documentation for AI-assisted development.

### Workspace Folder Design

User-selected directory via File System Access API (Chrome/Edge only). Structure: knowledge.ttl (legacy single-Graph), kbs/{String.fromCharCode(123)}name{String.fromCharCode(125)}/{String.fromCharCode(123)}name{String.fromCharCode(125)}.ttl + meta.json (multi-Graph; legacy kbs/{String.fromCharCode(123)}name{String.fromCharCode(125)}/kb.ttl still read as a fallback), knowledge.pending.jsonl (MCP inbox), settings_profile.json. Auto-exports on every graph mutation (2s debounce). sources.json was removed: it was written on export but never consumed on import, so it added disk writes without a reader.

### Workspace TTL Naming Convention

Each graph's Turtle file is named after its own folder — kbs/&lt;name&gt;/&lt;name&gt;.ttl — rather than a fixed kb.ttl inside each folder. Renaming a graph therefore renames both the directory and the file together, so `ls kbs/` is a legible index of every graph on disk and file managers/sync tools show meaningful names instead of a directory full of identically-named kb.ttl files. The reader still falls back to the legacy kbs/&lt;name&gt;/kb.ttl name (and migrates it to the new convention on next save) so older workspaces keep working.

## Triples and RDF

### @prefix Declaration

Declares a short alias for a namespace IRI. Example: @prefix rdf: &lt;http://www.w3.org/1999/02/22-rdf-syntax-ns#&gt; . Prefixes make Turtle readable -- without them every IRI needs full angle-bracket notation.

### Comma (,) -- Same Subject and Predicate

In Turtle, a comma separates objects that share the same subject and predicate. Example: ex:Earth ex:hasOcean ex:Pacific , ex:Atlantic , ex:Indian .

### IRI (Identifier)

A globally unique identifier for a resource. IRIs are the names of things in RDF -- like URLs but for any concept, not just web pages. Example: urn:reckons:guide/WhatIsReckonsAI

### JSON-LD

JSON-based serialization for RDF. Embeds linked data in standard JSON using a @context object. Popular for web APIs.

### Knowledge Graph

A graph-structured database where entities are nodes and relationships are edges. Multiple triples form a graph. The same subject can appear in many triples, creating a web of connected knowledge.

### Linked Data

Tim Berners-Lee's principles for publishing data on the web: use IRIs, use HTTP, provide useful RDF, and link to other datasets.

### Literal Values

A data value in RDF: a string, number, date, or boolean. Literals can have a language tag (@en) or a datatype IRI (^^xsd:integer). Example: '42'^^xsd:integer is a typed literal.

### Period (.) -- End of Statement Group

A period terminates a group of triples about the same subject.

### Plain Text Portability

Your knowledge graph exports as a .ttl file -- plain text, human-readable, no proprietary format. You can open it in any text editor, diff it with git, email it, or print it. When apps shut down and formats die, your .ttl file will still work. It is the most durable way to store knowledge.

### PROV-O (Provenance Ontology)

A W3C vocabulary for expressing provenance: who created something, when, and from what sources. Reckons.AI uses prov:wasDerivedFrom to link statements to their source.

### Provenance

Every triple in Reckons.AI carries its source. You always know where a fact came from, how trusted that source is, and when it was added. Metadata about metadata -- this is what makes a graph trustworthy.

### RDF (Resource Description Framework)

A W3C standard for representing knowledge as a graph of linked statements. The foundation of the Semantic Web. RDF itself is abstract -- Turtle, JSON-LD, and RDF/XML are concrete serialization formats.

### RDF Schema (RDFS)

A vocabulary for describing classes and properties: rdfs:Class, rdfs:subClassOf, rdfs:domain, rdfs:range, rdfs:label, rdfs:comment. Reckons.AI uses rdfs:label for human-readable entity names.

### Reification

Making a statement about a statement. In RDF, reification assigns an IRI to a triple so it can be annotated with provenance, confidence, or temporal bounds. Reckons.AI uses reification in its TTL export format.

### Semicolon (;) -- Same Subject

In Turtle, a semicolon separates predicate-object pairs that share the same subject. Example: ex:Earth rdf:type ex:Planet ; ex:orbits ex:Sun .

### SKOS (Simple Knowledge Organization System)

A vocabulary for taxonomies and concept hierarchies using skos:broader, skos:narrower, skos:related. This documentation file uses SKOS to organize concepts.

### SPARQL

The query language for RDF graphs. Like SQL for relational databases, but for triple stores. Example: SELECT ?name WHERE {String.fromCharCode(123)} ?person foaf:name ?name {String.fromCharCode(125)}

### Subject - Predicate - Object

Subject: the entity being described (always an IRI). Predicate: the relationship or property (always an IRI). Object: the value or target (an IRI or a literal string/number/date). Example: 'Alice worksAt AcmeCorp'. Example: 'Policy covers water-damage'.

### The Review Workflow

1. Ingest -- paste text, upload documents, import calendars. 2. Review -- the LLM extracts triples, you confirm or reject each one. 3. Explore -- navigate your 3D knowledge graph. 4. Ask Shelly -- get answers grounded in your confirmed facts. 5. Share -- export your .ttl.

### The Semantic Triple

The fundamental unit of knowledge in RDF: a three-part statement -- subject, predicate, object. Any fact expressible in human language can be expressed as a triple. Triples connect to form a graph, and graphs reveal relationships that documents hide.

### Turtle (.ttl) Syntax

A compact, human-readable syntax for writing RDF triples. File extension: .ttl. Uses prefix declarations, semicolons to share subjects, commas to share predicates, and periods to end statement groups. This file is itself written in Turtle.
