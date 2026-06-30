# Reckons KB (.ttl) vs Architectural Markdown — A Comparison

> This project uses **both** RDF knowledge bases (`.ttl` files) and traditional markdown documentation (`.md` files). They serve different purposes and complement each other. This document explains when to use which, how they differ in structure, and how they relate.

---

## Folder Structure

```
tripleNotes/
├── static/                        # TTL Knowledge Bases (machine + human readable)
│   ├── starter-guide.ttl          # Documentation hub — links to all sub-graphs
│   ├── starter-quickstart.ttl     # Example KB for new users (Alice, Bob, projects)
│   ├── docs-features.ttl          # All features as typed entities
│   ├── docs-integrations-tech.ttl # Tech stack & integrations
│   ├── docs-llm.ttl               # LLM concepts (hallucination, RAG, grounding)
│   ├── docs-use-cases.ttl         # Real-world use cases
│   ├── docs-tips-security.ttl     # Tips, privacy, content safety
│   ├── docs-triples-rdf.ttl       # RDF/Turtle standards explained as triples
│   ├── docs-timeline-ecosystem.ttl# Timeline of RDF ecosystem + Reckons.AI
│   ├── docs-all.ttl               # Combined doc graph (all sub-graphs merged)
│   ├── reckons-roadmap.ttl        # Product roadmap — feature status & design intent
│   └── reckons-production.ttl     # Production health — test suite, architecture
│
├── docs/                          # Markdown Documentation (prose-first, human readable)
│   ├── GUIDE.md                   # Complete user & developer guide
│   ├── STYLE_GUIDE.md             # Brand colors, typography, component patterns
│   ├── USER_STORIES.md            # User stories & acceptance criteria
│   ├── SECURITY.md                # Vulnerability tracking, CVEs, response process
│   ├── ENTERPRISE.md              # Enterprise roadmap (People, Policy, Procedure)
│   ├── N8N_INTEGRATION.md         # n8n cloud sync architecture & webhook API
│   ├── VSCODE_EXTENSION.md        # VS Code extension design
│   ├── MODEL_TRAINING.md          # Fine-tuning local models on KB data
│   ├── DEPENDENCIES.md            # Dependency audit & licence info
│   ├── PROV_O_ALIGNMENT.md        # PROV-O provenance ontology alignment
│   ├── MOBILE_CAPTURE.md          # Mobile capture workflow
│   ├── MOBILE_LOCAL_SERVER.md     # Mobile local server design
│   └── LOCAL_HOME_FOLDER.md       # Local home folder structure
│
├── README.md                      # Project overview & quick start
├── SETUP.md                       # Installation & deployment guide
├── AUDIT.md                       # Codebase audit, orphaned files, terminology
└── CLAUDE.md                      # AI agent instructions (Claude Code context)
```

---

## Side-by-Side: The Same Feature in Both Formats

### TTL (structured, queryable, graph-navigable)

From `static/docs-features.ttl`:

```turtle
@prefix feat:   <urn:reckons:feature/> .
@prefix ktype:  <urn:kbase:type/> .
@prefix skos:   <http://www.w3.org/2004/02/skos/core#> .

feat:MultiKB
    rdf:type            ktype:Concept ;
    rdfs:label          "Multi-KB Management" ;
    skos:definition     "Create, switch, rename, and delete independent knowledge
                         bases. Each KB has its own Dexie database, stable ID,
                         and statement count. Import TTL files as new KBs." ;
    skos:broader        guide:WhatIsReckonsAI ;
    skos:related        feat:KBLeap ;
    skos:related        feat:ImportAsNewKB .

feat:KBLeap
    rdf:type            ktype:Concept ;
    rdfs:label          "KB Leap" ;
    skos:definition     "Cross-reference entities between knowledge bases.
                         A urn:reckons:leap predicate stores the target KB's
                         stable ID. Click the jump button to switch." ;
    skos:broader        feat:MultiKB .
```

### Markdown (prose, procedural, developer-facing)

From `docs/GUIDE.md`:

```markdown
## Multi-KB Management

Create, switch, rename, and delete independent knowledge bases.
Each KB has its own IndexedDB database.

### Creating a KB

1. Open Settings → Knowledge Bases
2. Click "New KB"
3. Enter a name
4. You're switched to the new KB immediately

### KB Leap (cross-references)

When an entity contains a `urn:reckons:leap` predicate, a jump
button appears in the node panel. Clicking it:

1. Looks up the target KB's stable ID in the registry
2. Calls `switchToKb()` which reloads the page
3. Opens the target KB with the linked entity focused
```

---

## When to Use Which

| Dimension | TTL Knowledge Base | Markdown |
|---|---|---|
| **Audience** | AI agents, MCP tools, graph UI, end users | Developers, contributors, code reviewers |
| **Queryable** | Yes — BM25 search, SPARQL-like, subgraph traversal | No — text search only |
| **Structure** | Entity → predicate → value triples | Headers → paragraphs → code blocks |
| **Cross-references** | Typed links (`skos:related`, `skos:broader`, KB Leap) | Markdown links, relative paths |
| **Versioning** | Diffs show triple-level changes | Diffs show text-level changes |
| **Rendering** | 3D/2D graph, entity cards, story tours | Static text, rendered HTML |
| **Compression** | `kb_compress` reduces to ~30-40% of tokens | No built-in compression |
| **Machine consumption** | Direct — MCP tools, LLM context, embedding | Requires parsing, no standard schema |
| **Prose explanations** | Awkward — `skos:definition` strings only | Natural — full narrative flow |
| **Step-by-step guides** | Poor — no ordered sequences | Excellent — numbered lists, code blocks |
| **Diagrams** | Not supported (no visual markup) | ASCII art, Mermaid, code fences |
| **API docs** | Entities per endpoint, but no request/response examples | Full curl examples, tables, response schemas |
| **Change tracking** | `kpred:has-status` values, MCP alignment scoring | Git blame, PR descriptions |

### Rules of Thumb

- **Use TTL** when the information is about *what exists* and *how things relate*: features, entities, status, dependencies, cross-references.
- **Use Markdown** when the information is about *how to do something*: setup steps, API usage, vulnerability response, design rationale, architectural ASCII diagrams.
- **Use both** for major features: TTL for the structured graph (queryable by AI), Markdown for the developer narrative (readable by humans doing the work).

---

## Structural Patterns

### TTL: Hub + Sub-Graph Pattern

The documentation KBs use a hub-and-spoke architecture:

```
starter-guide.ttl (hub)
    │
    ├── docs-features.ttl         (33 entities, 143 triples)
    ├── docs-integrations-tech.ttl (28 entities, 114 triples)
    ├── docs-llm.ttl              ( 9 entities,  46 triples)
    ├── docs-use-cases.ttl        ( 9 entities,  42 triples)
    ├── docs-tips-security.ttl    (16 entities,  79 triples)
    ├── docs-triples-rdf.ttl      (23 entities, 121 triples)
    └── docs-timeline-ecosystem.ttl(39 entities, 194 triples)
```

**How it works:**
1. The hub (`starter-guide.ttl`) contains **KB Leap nodes** — entities with `<urn:reckons:leap>` predicates pointing to each sub-graph's stable ID.
2. Sub-graphs contain a **nav:BackToHub** entity that leaps back to the hub.
3. Users click through the graph to navigate between sub-graphs.
4. Each sub-graph has its own `<urn:reckons:meta/kbStableId>` for identity.

```turtle
# Hub leap node (in starter-guide.ttl)
leap:Features
    rdf:type            ktype:Document ;
    rdfs:label          "Features" ;
    skos:definition     "All major features..." ;
    <urn:reckons:leap>          "a1b2c3d4-e5f6-4a04-b004-000000000004" ;
    <urn:reckons:leap/label>    "Feature Documentation" .

# Back-link (in docs-features.ttl)
nav:BackToHub
    rdf:type            ktype:Document ;
    rdfs:label          "Back to Documentation Hub" ;
    <urn:reckons:leap>          "a1b2c3d4-e5f6-4a00-b000-000000000000" ;
    <urn:reckons:leap/label>    "Documentation Hub" .
```

### TTL: Entity Typing and Vocabulary

Every entity has a consistent structure:

```turtle
feat:Ingest
    rdf:type            ktype:Concept ;     # Typed: Concept, Tool, Person, etc.
    rdfs:label          "Ingest" ;          # Human-readable label
    skos:definition     "Add knowledge..." ;# Definition paragraph
    skos:broader        guide:WhatIsReckonsAI ;  # Hierarchy (broader/narrower)
    skos:related        feat:ReviewSystem . # Related concepts
```

Common predicates across TTL files:
- `rdf:type` — entity type (`ktype:Concept`, `ktype:Feature`, `ktype:Framework`, `ktype:Person`)
- `rdfs:label` — display name
- `skos:definition` — paragraph-length description
- `skos:broader` / `skos:narrower` — hierarchy
- `skos:related` — lateral links
- `kpred:has-status` — lifecycle (`production`, `functional`, `planned`, `speculative`)
- `kpred:depends-on` — dependency edges
- `<urn:reckons:leap>` — cross-KB navigation

### TTL: Operational KBs vs Documentation KBs

| KB | Purpose | Entities | Triples | Prefix style |
|---|---|---|---|---|
| `reckons-roadmap.ttl` | Product planning — what to build next | 96 | 507 | `kb:` (concept namespace) |
| `reckons-production.ttl` | System health — what's deployed | 33 | 210 | `kb:` (concept namespace) |
| `docs-features.ttl` | User docs — how features work | 33 | 143 | `feat:` (feature namespace) |
| `starter-guide.ttl` | Doc hub — navigation + overview | 50 | 208 | `guide:`, `leap:` |
| `starter-quickstart.ttl` | Example — teach Turtle by example | 15 | 46 | `kb:` (generic) |

### Markdown: Flat Structure with Cross-References

Markdown docs are a flat folder. Cross-references are manual:

```
docs/
├── GUIDE.md           # References: STYLE_GUIDE.md, SETUP.md
├── STYLE_GUIDE.md     # Self-contained
├── SECURITY.md        # Self-contained
├── ENTERPRISE.md      # References: N8N_INTEGRATION.md
├── N8N_INTEGRATION.md # Self-contained
└── ...
```

No formal link graph. A reader must know which file to open. There is no equivalent to the TTL hub's graph-navigable leap nodes.

---

## Size Comparison

### TTL Files (12 files, ~4,730 lines)

| File | Lines | Size | Entities | Triples |
|---|---|---|---|---|
| `docs-all.ttl` | 1,563 | 88K | 174 | 804 |
| `reckons-roadmap.ttl` | 731 | 40K | 96 | 507 |
| `starter-guide.ttl` | 461 | 28K | 50 | 208 |
| `reckons-production.ttl` | 320 | 20K | 33 | 210 |
| `docs-timeline-ecosystem.ttl` | 320 | 20K | 39 | 194 |
| `docs-features.ttl` | 302 | 20K | 33 | 143 |
| `docs-integrations-tech.ttl` | 214 | 12K | 28 | 114 |
| `docs-triples-rdf.ttl` | 213 | 12K | 23 | 121 |
| `starter-quickstart.ttl` | 160 | 12K | 15 | 46 |
| `docs-tips-security.ttl` | 155 | 8K | 16 | 79 |
| `docs-llm.ttl` | 102 | 8K | 9 | 46 |
| `docs-use-cases.ttl` | 98 | 8K | 9 | 42 |

### Markdown Files (16 files, ~3,979 lines)

| File | Lines | Size | Purpose |
|---|---|---|---|
| `docs/GUIDE.md` | 484 | 20K | Complete user & developer guide |
| `docs/USER_STORIES.md` | 416 | 20K | User stories & acceptance criteria |
| `docs/VSCODE_EXTENSION.md` | 342 | 12K | VS Code extension design |
| `docs/MOBILE_LOCAL_SERVER.md` | 325 | 12K | Mobile local server |
| `docs/PROV_O_ALIGNMENT.md` | 265 | 12K | PROV-O ontology alignment |
| `SETUP.md` | 255 | 12K | Installation & deployment |
| `docs/SECURITY.md` | 248 | 12K | Vulnerability tracking |
| `docs/ENTERPRISE.md` | 242 | 8K | Enterprise roadmap |
| `docs/STYLE_GUIDE.md` | 226 | 8K | Brand & UI patterns |
| `README.md` | 215 | 12K | Project overview |
| `docs/LOCAL_HOME_FOLDER.md` | 215 | 12K | Local home folder |
| `AUDIT.md` | 208 | 12K | Codebase audit |
| `docs/MOBILE_CAPTURE.md` | 193 | 12K | Mobile capture |
| `docs/N8N_INTEGRATION.md` | 157 | 8K | n8n cloud sync |
| `docs/MODEL_TRAINING.md` | 148 | 8K | Model fine-tuning |
| `docs/DEPENDENCIES.md` | 131 | 8K | Dependency audit |

---

## How They Work Together

### MCP-Powered AI Workflow

The TTL files are the source of truth for the MCP server. When Claude Code (or any MCP client) needs context:

```
Developer question: "What's the status of the n8n integration?"

1. Claude Code calls: kb_search("n8n integration", kb="roadmap")
   → Returns: kb:n8n-cloud-sync entity with kpred:has-status "production"

2. For implementation details: reads docs/N8N_INTEGRATION.md
   → Gets: webhook URLs, curl examples, architecture diagram

3. For compressed LLM context: kb_compress("n8n", budget=1000)
   → Returns: ~400 tokens of entity-grouped facts (vs ~3000 tokens raw)
```

### Overlapping Coverage

Some topics exist in both formats. The overlap is intentional:

| Topic | TTL Coverage | Markdown Coverage |
|---|---|---|
| **Features** | `docs-features.ttl` — 33 typed entities with definitions, relationships, and status | `docs/GUIDE.md` — step-by-step usage instructions, screenshots, config examples |
| **n8n Sync** | `reckons-roadmap.ttl` — `kb:n8n-cloud-sync` entity with status, dependencies | `docs/N8N_INTEGRATION.md` — webhook API, curl examples, architecture ASCII art |
| **Enterprise** | `reckons-roadmap.ttl` — `kb:enterprise-ppp` with phases, dependencies | `docs/ENTERPRISE.md` — the 3 Ps framework, RBAC design, auth gateway prose |
| **Security** | `docs-tips-security.ttl` — content safety entities, privacy principles | `docs/SECURITY.md` — specific CVEs, npm audit output, CI gate YAML |
| **Tech stack** | `reckons-production.ttl` — typed entities per library with versions | `docs/DEPENDENCIES.md` — licence audit, upgrade notes |

**The TTL answers "what" and "how it relates."**
**The Markdown answers "how to" and "why."**

### Update Workflow

When a feature ships or changes:

1. **Update TTL** — change `kpred:has-status` from `"planned"` to `"production"`, add new triples for sub-features.
2. **Update Markdown** — add usage instructions, configuration, examples.
3. **MCP auto-reloads** — the MCP server watches TTL files and picks up changes immediately.
4. **`kb_alignment_score`** — run to verify code changes match KB entities (quantitative 0-1 score).

---

## Example: Creating a New Feature Doc in Both Formats

### Step 1: TTL entity (in `reckons-roadmap.ttl`)

```turtle
kb:new-feature  rdf:type         ktype:Feature ;
                rdfs:label       "New Feature" ;
                kpred:has-status "planned" ;
                kpred:depends-on kb:existing-feature ;
                kpred:description "One-sentence purpose." ;
                kpred:priority   "high" .
```

### Step 2: TTL docs (in `docs-features.ttl`)

```turtle
feat:NewFeature
    rdf:type            ktype:Concept ;
    rdfs:label          "New Feature" ;
    skos:definition     "Paragraph explaining what the feature does, how it works,
                         and what it connects to. This text appears in the graph UI
                         when users click the entity." ;
    skos:broader        guide:WhatIsReckonsAI ;
    skos:related        feat:ExistingFeature .
```

### Step 3: Markdown (in `docs/NEW_FEATURE.md`)

```markdown
# New Feature

> One-line summary.

## Architecture

[ASCII diagram showing components]

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `settingName` | `"value"` | What it controls |

## Usage

1. Step one
2. Step two
3. Step three

## API

### `POST /webhook/endpoint`

```bash
curl -X POST https://... -d '{"key": "value"}'
```
```

---

## Key Takeaways

1. **TTL is the canonical source for AI agents.** The MCP server queries TTL, not Markdown. If you want AI tools to know about something, it must be in a TTL file.

2. **Markdown is the canonical source for developers.** Step-by-step guides, API docs, and design rationale belong in Markdown where they render naturally on GitHub and in editors.

3. **The hub+sub-graph pattern in TTL** replaces the flat folder problem of Markdown. Users navigate by clicking through a graph instead of guessing filenames.

4. **Compression makes TTL uniquely efficient for LLM context.** `kb_compress` delivers ~60-70% token reduction, making it practical to inject full KB context into every LLM call. Markdown has no equivalent.

5. **Both formats version cleanly in git.** TTL diffs show triple-level changes; Markdown diffs show text-level changes. Both are text files, both are reviewable in PRs.

6. **Update both when shipping features.** TTL for the graph (status, relationships, definitions). Markdown for the narrative (how-to, examples, diagrams).
