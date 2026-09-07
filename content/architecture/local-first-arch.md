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

All user data lives in browser IndexedDB (Dexie v4). No server, no accounts, no cloud dependency. The app is a static SvelteKit build. Export to .ttl for portability. Workspace folder sync for disk backup and MCP server access.

## In this section

### Dependency Health

Core deps: svelte 5, sveltekit 2, dexie 4, n3 1.x, three 0.169, @huggingface/transformers 3.x, bits-ui 2.x, fflate 0.8. Dev deps: vitest 4.x, playwright 1.x, typescript 5.x. All deps actively maintained. No abandoned packages. Browser-only runtime — no server deps in production.

**[PROV-O Alignment](../architecture/prov-o-alignment)**

Partial alignment with W3C PROV-O ontology.

### RDF Vocabulary Decisions

Standard: rdf:type, rdfs:label, skos:definition, skos:broader, skos:related, skos:note. Custom: urn:kbase:type/ (entity types), urn:kbase:predicate/ (user predicates), urn:kbase:meta/ (reification metadata: status, source, confidence, excerpt, timestamps). urn:reckons: namespace for product-specific vocab (leap, shelly, feature).

**[Static Deployment](../architecture/static-deployment)**

SvelteKit adapter-static produces a pure client-side build.

**[Workspace Folder Design](../architecture/workspace-folder-design)**

User-selected directory via File System Access API (Chrome/Edge only).
