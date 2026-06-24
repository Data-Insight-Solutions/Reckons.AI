# Reckons.AI

A personal knowledge graph that turns documents, web pages, and notes into a structured graph of facts — stored as a standard **Turtle** (`.ttl`) file on your device.

You own the file. You review and confirm every fact. Nothing leaves your device unless you choose to share it.

---

## What it does

```
note / url / doc / .ttl / calendar / extension
        |
        v
   AI extraction
        |
        v
   Review & confirm  <-- only what you approve enters your KB
        |
        v
   3D knowledge graph   Reckoning (decision support)   Share .ttl
```

1. **Ingest** — paste a note, URL, document, calendar, or an existing `.ttl` file from someone else
2. **Review** — confirm or reject each proposed triple; refine labels before accepting
3. **Explore** — 3D force-directed graph with hub emphasis, layout modes, filter chips, and 2D fallback
4. **Reckon** — describe a situation and a target; the AI proposes options grounded in your KB
5. **Compare** — import a `.ttl` file or analyze a page to see what's new, conflicting, or reinforcing
6. **Share** — export `.ttl` and send it to collaborators; they see the diff on import

---

## Key features

- **Multi-KB management** — create, switch, rename, and delete independent knowledge bases
- **KB Leap** — cross-reference entities between KBs; click to jump between them
- **Browser extension** — compare any webpage against your KB, accumulate research sessions across tabs, batch ingest
- **MCP server** — expose your KB to Claude Desktop, Cursor, and other MCP-compatible AI agents
- **Predicate Manager** — view, rename, and merge predicates across your KB
- **Content safety** — ethics preamble in all LLM prompts, content classifier, export advisory
- **Passage grounding** — verbatim source excerpts attached to extracted triples
- **Diff summaries** — LLM-generated 3-part summaries (new/reinforcing/conflicting)
- **Whisper STT** — local speech-to-text via transformers.js (no cloud required)
- **Kokoro TTS** — local text-to-speech for story walkthroughs
- **Per-task LLM backends** — use different providers for ingest, chat, analysis, and diff summary
- **Model cache management** — inspect, sideload, and purge locally cached WASM models
- **Source trust system** — sources earn trust through consistent accuracy; trusted sources auto-confirm
- **History mode** — time-travel through your KB with a timeline scrubber
- **Cross-KB alignment** — align entities across knowledge bases with embedding similarity and IRI remapping
- **n8n cloud sync** — private cloud sync via self-hosted n8n VPS; upload, download, and monitor KBs
- **Source monitoring** — watch URLs for changes, detect diffs, queue pending notes automatically
- **GitHub repo ingest** — ingest repository structure and code as knowledge with delta compare
- **Entity normalisation** — embedding-based IRI rewriting prevents duplicate entities at ingest time
- **Self-dogfooding MCP workspace** — the product tracks its own roadmap and status via its own MCP server

---

## Quick start

```bash
cp .env.example .env   # add at least one AI backend key (or leave blank for WASM)
pnpm install
pnpm dev               # http://localhost:5173
```

No AI key required — the local WASM backend works out of the box (slower, fully offline).

For Docker:

```bash
docker compose up      # http://localhost:5173
```

---

## AI backends

| Backend | Cost | Privacy | Quality |
|---|---|---|---|
| **WASM (built-in)** | Free | 100% local | Low-medium |
| **Ollama** | Free | 100% local | High |
| **Chrome built-in AI** | Free | Local (Chrome only) | Medium |
| **OpenRouter** | Free tier available | Third-party | High |
| **Gemini** | Free tier (1,500 req/day) | Google | High |
| **Claude** | Pay-per-token | Anthropic | Highest |
| **OpenAI** | Pay-per-token | OpenAI | High |
| **Manual paste** | Free | Any LLM | Any |

Full setup details in [`SETUP.md`](SETUP.md) and [`docs/GUIDE.md`](docs/GUIDE.md).

---

## Tech stack

- **SvelteKit 2 + Svelte 5** (runes) — frontend framework
- **Threlte 8 / Three.js** — 3D force-directed knowledge graph
- **Dexie** — IndexedDB persistence (all data stays in-browser)
- **N3.js** — W3C RDF/Turtle parsing and serialization
- **@huggingface/transformers** — local WASM LLM and embedding inference
- **Playwright** — end-to-end test suite

---

## Data model

Every fact is a `Statement` — an RDF triple with provenance:

```ts
{
  s: { kind: 'iri', value: 'urn:kbase:person/alice' },
  p: { kind: 'iri', value: 'urn:kbase:predicate/organized' },
  o: { kind: 'iri', value: 'urn:kbase:event/float-trip' },
  g: { kind: 'iri', value: 'urn:kbase:source/<uuid>' },  // provenance
  sourceId: '<uuid>',
  confidence: 0.95,
  status: 'confirmed',   // pending | confirmed | refined | rejected | superseded
  excerpt: 'Alice organized the float trip last summer.',  // verbatim source sentence
}
```

Exported as standard Turtle (`.ttl`) — readable by any RDF tool.

---

## Browser extension

The extension adds a side panel with three tabs:

- **Compare** — analyze the current page against your KB with at-a-glance proportional bar
- **Session** — accumulate findings across multiple pages with aggregate summaries and batch ingest
- **Ingest** — send extracted triples to Reckons.AI

Supports Chrome, Edge, Brave, Firefox desktop, and Firefox for Android.

See [`SETUP.md`](SETUP.md) for installation instructions.

---

## MCP server

The standalone MCP server (`mcp-server/`) exposes 11 tools to AI agents:

| Tool | Description |
|------|-------------|
| `kb_list_kbs` | List all available knowledge bases |
| `kb_search` | Full-text BM25 search over KB entities and statements |
| `kb_get_entity` | Get all statements for a specific entity |
| `kb_list_entities` | List all entities with type and connection count |
| `kb_stats` | Return KB statistics (entity count, statement count, types) |
| `kb_add_note` | Add a note for extraction and review |
| `kb_subgraph` | Extract a subgraph around an entity (configurable depth) |
| `kb_reckoning` | Run a Situation-Target-Proposal analysis |
| `kb_list_sources` | List all sources with metadata and trust scores |
| `kb_request_refresh` | Request a source refresh by source ID |
| `kb_add_triple` | Directly add a triple with subject, predicate, object |

### Self-dogfooding workspace

Reckons.AI uses its own MCP server to track product state. Three internal KBs (Roadmap, Production, Features) are symlinked from `static/*.ttl` into `mcp-workspace/kbs/`. Claude Code queries these KBs before planning new work or modifying architecture. Edit a TTL file → the MCP server auto-reloads → the next AI session sees the change.

```bash
bash scripts/setup-mcp-workspace.sh   # one-time setup after cloning
```

---

## Documentation

| Doc | Contents |
|---|---|
| [`SETUP.md`](SETUP.md) | Setup guide — dev, extension, Ollama, Docker, self-hosting, multi-KB |
| [`docs/GUIDE.md`](docs/GUIDE.md) | Full user + developer guide — backends, review, graph, voice, merge, architecture |
| [`docs/STYLE_GUIDE.md`](docs/STYLE_GUIDE.md) | Brand colors, typography, component patterns, z-index scale |
| [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) | Dependency health, browser support matrix, replacement candidates |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Known CVEs, risk assessments, vulnerability response process |
| [`docs/USER_STORIES.md`](docs/USER_STORIES.md) | Collaborative use case scenarios |
| [`docs/N8N_INTEGRATION.md`](docs/N8N_INTEGRATION.md) | n8n cloud sync — architecture, API, sync scripts |
| [`docs/ENTERPRISE.md`](docs/ENTERPRISE.md) | Enterprise roadmap — People, Policy, Procedure framework |

---

## Documentation KB

The app ships with a built-in documentation graph (`starter-guide.ttl`) containing:
- Core philosophy and getting-started steps
- **KB Leap nodes** linking to 7 deep-dive sub-graphs (auto-imported on first click):
  - Triples & RDF standards
  - Language models & RAG
  - Real-world use cases
  - All features
  - Integrations & technology
  - Tips & security
  - Timeline & RDF ecosystem
- A guided story walkthrough narrated by Shelly

---

## Context compression

Knowledge graphs are dense by nature. Reckons.AI compresses what you know into structured RDF triples — retaining semantic meaning while reducing the tokens an AI needs to understand your situation. A page of prose becomes a handful of triples. Same meaning, fraction of the tokens. Feed your compressed KB directly to AI agents via MCP.

---

## Enterprise roadmap

Structure organisational knowledge around **People · Policy · Procedure** — the three dimensions that matter. RBAC, bring-your-own auth (SSO/LDAP/OIDC), file-based `.ttl` delivery, and self-hosted deployment via n8n. See [`docs/ENTERPRISE.md`](docs/ENTERPRISE.md).

---

## Things that are deliberately absent

- **No backend server** — all state in IndexedDB; Turtle export for backup. Optional n8n cloud sync is self-hosted.
- **No accounts** — your KB is yours alone, on this device. Enterprise RBAC is an opt-in layer.
- **No analytics, no tracking, no remote logging**
- URL ingestion proxies through `r.jina.ai/<url>` for clean-text extraction; use the note or document tab to avoid that hop entirely
