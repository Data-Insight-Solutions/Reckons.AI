---
title: "Markdown Migration Status"
slug: "migration-status"
order: 1021
section: "Architecture"
parent: "ttl-first-docs"
template: doc
status: published
nav: sidebar
excerpt: "Tracking which markdown docs have been migrated to TTL graphs."
generated: "docs-kb"
---

# Markdown Migration Status

Tracking which markdown docs have been migrated to TTL graphs. Goal: eliminate all docs/*.md files except where markdown format is structurally required (GitHub conventions, Claude Code system files).

<p class="derived">It has 15 parts below.</p>

## In this section

**[CONFLUENCE_MIGRATION.md → Superseded](../architecture/mig-confluence)**

docs/CONFLUENCE_MIGRATION.md (490 lines) is a detailed design doc for F26.

### DEPENDENCIES.md → Superseded

docs/DEPENDENCIES.md (131 lines) is a dependency health review. Already captured in reckons-production.ttl (tech stack entities with versions). Add dep health status as kpred:dep-status. Safe to delete after expansion.

#### Detail

**Status**

superseded

### ENTERPRISE.md → Superseded

docs/ENTERPRISE.md (242 lines) covers F21 People/Policy/Procedure. Already has entity in reckons-roadmap.ttl. Four phase entities need to be added (RBAC, auth gateway, policy modeling, team workflows). Safe to delete after expansion.

#### Detail

**Status**

superseded

### GUIDE.md → Superseded

docs/GUIDE.md (484 lines) is fully superseded by the TTL documentation hub (starter-guide.ttl) and 7 sub-graph TTLs (features, integrations, llm, use-cases, tips, triples, timeline). Safe to delete.

#### Detail

**Status**

superseded

### KB_VS_MARKDOWN.md → Superseded

docs/KB_VS_MARKDOWN.md (384 lines) is a meta-document comparing TTL vs markdown. Its content is now captured in this architecture graph (TtlFirstDocs section). Safe to delete.

#### Detail

**Status**

superseded

### LOCAL_HOME_FOLDER.md → Superseded

docs/LOCAL_HOME_FOLDER.md (215 lines) covers the workspace folder concept. Already implemented (src/lib/stores/workspace.svelte.ts). Architecture captured in docs-integrations-tech.ttl (WorkspaceSync) and docs-features.ttl (MultiKB). Safe to delete.

#### Detail

**Status**

superseded

### MOBILE_CAPTURE.md → Superseded

docs/MOBILE_CAPTURE.md (193 lines) covers async voice note capture via n8n webhooks. Design concept, not implemented. Add as a roadmap feature entity with the key design decisions as properties.

#### Detail

**Status**

superseded

### MOBILE_LOCAL_SERVER.md → Superseded

docs/MOBILE_LOCAL_SERVER.md (325 lines) covers running the app on a Linux server with Ollama and accessing via QR code. Setup steps are procedural but the architecture decisions (CORS, SSL, Ollama remote binding) are entity-friendly. Add as entities in docs-integrations-tech.ttl.

#### Detail

**Status**

superseded

### MODEL_TRAINING.md → Superseded

docs/MODEL_TRAINING.md (148 lines) covers F13 fine-tuning. Already has entity in reckons-roadmap.ttl. Three phase entities need to be added (training data export, cloud fine-tuning, local LoRA). Safe to delete after expansion.

#### Detail

**Status**

superseded

### N8N_INTEGRATION.md → Superseded

docs/N8N_INTEGRATION.md (157 lines) documents n8n workflows and data tables. Already captured in docs-integrations-tech.ttl (N8nCloudSync, N8nSyncHub, N8nSourceMonitor) and docs-features.ttl (SourceMonitoring). Workflow IDs and data table IDs need to be added as literal properties. Safe to delete after expansion.

#### Detail

**Status**

superseded

### PROV_O_ALIGNMENT.md → Superseded

docs/PROV_O_ALIGNMENT.md (265 lines) analyzes alignment with W3C PROV-O ontology. Standards alignment decisions belong in this architecture graph. Key decisions: partial alignment (source provenance yes, activity chains no), custom urn:kbase: namespace preferred over prov: for simplicity.

#### Detail

**Status**

superseded

### SECURITY.md → Partially Superseded

docs/SECURITY.md (248 lines) covers vulnerability tracking and response process. Security architecture is in docs-tips-security.ttl but vulnerability tracking and incident response procedures need expansion. The vulnerability log format (CVE-like entries) is procedural — use skos:note on security entities.

#### Detail

**Status**

partial

### STYLE_GUIDE.md → Hybrid

docs/STYLE_GUIDE.md (226 lines) contains CSS variable tables and component patterns. The conceptual summary belongs in TTL (this graph). The literal CSS values (hex codes, font stacks, z-index numbers) should live as code comments in the CSS source files. A TTL entity with the key conventions exists here (arch:StyleConventions).

#### Detail

**Status**

hybrid

### USER_STORIES.md → Superseded

docs/USER_STORIES.md (416 lines) covers collaborative reckoning stories. The individual empowerment use cases already exist in docs-use-cases.ttl. The collaborative stories should be added there too.

#### Detail

**Status**

superseded

### VSCODE_EXTENSION.md → Superseded

docs/VSCODE_EXTENSION.md (342 lines) covers F19 VS Code extension. Already captured in docs-integrations-tech.ttl (VSCodeExtension entity with 3 phases). Safe to delete.

#### Detail

**Status**

superseded
