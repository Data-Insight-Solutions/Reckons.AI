---
title: "Local-First Architecture"
slug: "local-first-arch"
order: 1020
section: "Architecture"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "All user data lives in browser IndexedDB (Dexie v4)."
generated: "docs-kb"
---

# Local-First Architecture

*Concept*

All user data lives in browser IndexedDB (Dexie v4). No server, no accounts, no cloud dependency. The app is a static SvelteKit build. Export to .ttl for portability. Workspace folder sync for disk backup and MCP server access.

## Steps

**[Dependency Health](../architecture/dependency-health)**

Core deps: svelte 5, sveltekit 2, dexie 4, n3 1.x, three 0.169, @huggingface/transformers 3.x, bits-ui 2.x, fflate 0.8.

**[PROV-O Alignment](../architecture/prov-o-alignment)**

Partial alignment with W3C PROV-O ontology.

**[RDF Vocabulary Decisions](../architecture/rdf-vocabulary)**

Standard: rdf:type, rdfs:label, skos:definition, skos:broader, skos:related, skos:note.

**[Static Deployment](../architecture/static-deployment)**

SvelteKit adapter-static produces a pure client-side build.

**[Workspace Folder Design](../architecture/workspace-folder-design)**

User-selected directory via File System Access API (Chrome/Edge only).
