# Reckons.AI — Project Audit

## 1. Dependency & License Audit

All production dependencies use permissive open-source licenses. The project is fully self-hostable.

| Package | License | Notes |
|---------|---------|-------|
| svelte / @sveltejs/kit | MIT | UI framework |
| vite | MIT | Build tool |
| three.js | MIT | 3D rendering |
| @threlte/core, @threlte/extras | MIT | Svelte + Three.js bridge |
| dexie | Apache 2.0 | IndexedDB wrapper |
| @xenova/transformers | Apache 2.0 | In-browser ML (local embeddings) |
| n3 | MIT | RDF/Turtle parser |
| uuid | MIT | ID generation |
| comlink | Apache 2.0 | Web Worker RPC |
| @anthropic-ai/sdk | MIT | Claude API client (cloud, optional) |
| @vite-pwa/sveltekit | MIT | PWA support |

**Local-first status**: The app runs with zero cloud dependencies. LLM is optional and can be replaced entirely by Ollama (fully local). The `@anthropic-ai/sdk` package is MIT-licensed but the service requires an API key — Ollama provides a no-account alternative.

**Recommended for full open-source stack**:
- Set backend to **ollama** with `llama3.2` or `mistral`
- Disable Google Calendar/Drive integration (Settings → Google section)
- Embeddings use `@xenova/transformers` locally — no change needed

---

## 2. Terminology Consistency

| Term | Where | Verdict |
|------|-------|---------|
| **reject** | DiffEntry, pendingStatements | ✅ Correct — used for pending suggestions |
| **delete** | Node panel action button | ✅ Correct — applied to graph entities |
| **source** | All stores, UI | ✅ Consistent |
| **statement** vs **triple** | Code uses "statement", Turtle format calls them "triples" | ✅ Acceptable — "statement" is the RDF spec term |
| **entity** vs **node** | Graph uses "node", KB uses "entity" | ⚠️ Slightly inconsistent; "entity" is preferred in UI labels |
| **Shelly** vs **Turtle companion** | Component named TurtleShell/TurtleChatPanel, referred to as "Shelly" in UX | ✅ "Shelly" is the UX name; keep component names technical |
| **kb** vs **knowledge base** vs **KB** | Varied | ⚠️ Normalise to "KB" in UI, "kb" in IDs/code |
| **pending-removal** | ReviewStatus | ✅ New, clearly named |
| **review** | Route /review, button labels | ✅ Consistent |
| **ingest** | Route /ingest, store | ✅ Consistent |

---

## 3. Orphaned / Unused Files

| File | Status | Action |
|------|--------|--------|
| `src/lib/3d/AtmosphericField.svelte` | Commented out in layout, unreferenced | Remove or re-enable |
| `src/lib/components/TurtleCompanion.svelte` | Superseded; TurtleShell also removed | **Delete** |
| `src/lib/components/TurtleShell.svelte` | Removed from layout in session 3; may still exist on disk | **Delete** |
| `src/lib/components/DisambiguationPanel.svelte` | Superseded by comparison view roadmap | **Delete** |
| `src/lib/stores/disambiguation.svelte.ts` | Superseded by comparison view roadmap | **Delete** |
| `src/lib/3d/vr/VRShell.svelte` | Scaffold, not connected to any route | Keep (roadmap C) |
| `src/lib/3d/ar/ARShell.svelte` | Scaffold, not connected to any route | Keep (roadmap C) |
| `src/lib/components/VoiceInput.svelte` | Scaffold, Hume.AI integration pending | Keep (roadmap B) |
| `src/routes/api/merge-analysis.ts` | **Invalid SvelteKit route** — missing `+` prefix | Rename to `src/routes/api/merge-analysis/+server.ts` |
| `src/lib/components/RadialMenu.svelte` | Usage unverified | Verify imports before deleting |

---

## 4. Roadmap

### A — Comparison View (replaces Semfile + Disambiguation Panel plans)

The core workflow need: when a new source arrives (ingest, re-analysis, or a second KB), the user needs a clear side-by-side view of what would change and why. The existing `/review` three-tab approach (Incoming / Deletions / Merges) is a good foundation but needs a dedicated, richer comparison surface.

**Goals:**
- Compare any two KB snapshots: current KB vs. new ingest source, KB vs. re-analysis run, KB A vs. KB B
- Display every suggested change categorised as:
  - **Add** — new statement not in the target KB
  - **Reinforce** — statement already exists; this source agrees (increases confidence / trust score)
  - **Conflict** — same (subject, predicate) with a different object — highlight temporal or factual disagreement
  - **Merge** — two entity IRIs that likely refer to the same real-world thing
  - **Remove** — statement in target KB that the source contradicts or marks for deletion
- Allow bulk accept / reject per category, or statement-by-statement review
- Show provenance clearly: which source proposed each change, trust score, timestamp
- Accessible from `/compare` (already scaffolded for KB-vs-KB) and inline from `/review` as a "full comparison" link

**Files to build / extend:**
- `src/routes/compare/+page.svelte` — extend existing Venn/diff scaffold into full comparison surface
- `src/lib/rdf/compare.ts` — diff engine: takes two `Statement[]` arrays, returns categorised `CompareResult`
- `src/lib/components/CompareTable.svelte` — row-per-statement table with action buttons and category badges

**Removed plans (superseded by comparison view):**
- Semfile format — custom binary/text format not needed; Turtle import + comparison view covers the use case
- `DisambiguationPanel.svelte` / `disambiguation.svelte.ts` — merge suggestions surface into comparison view Merges category; standalone panel is redundant

---

### B — MCP Server + Cloud Sync

The MCP (Model Context Protocol) server extends Reckons.AI into a persistent personal AI assistant reachable from any device or AI client. This is the primary path to daily-driver usefulness.

#### Architecture

```
Mobile / Claude app / CLI
  ↓ MCP protocol (JSON-RPC over HTTP/SSE)
reckons-mcp-server (Node.js or Deno)
  ↓ REST / WebSocket
Reckons.AI web app  ←→  Cloud storage (Google Drive)
  ↓
User's KB (IndexedDB, local-first; synced to Drive)
```

#### Core MCP tools to expose

| Tool | Description |
|------|-------------|
| `kb_query` | Answer a natural-language question against the confirmed KB |
| `kb_add_note` | Add a quick note; Shelly extracts triples and queues for review |
| `kb_search` | Keyword or semantic search over entities and statements |
| `kb_status` | Return pending review count, trust scores, recent changes |
| `kb_list_kbs` | List available KBs for the authenticated user |
| `kb_switch` | Set active KB for subsequent calls |
| `calendar_today` | Return today's calendar events as KB-enriched context |

#### KB identity (implemented — `src/lib/storage/kb-fingerprint.ts`)

Every KB carries two complementary identifiers, both derived locally with no account required:

| Identifier | Derivation | Changes? | Used for |
|---|---|---|---|
| **Stable KB ID** | UUID generated once at KB creation, stored in settings | Never | MCP routing, Drive folder naming, cross-device references |
| **Content fingerprint** | SHA-256 of sorted canonical N-Quads of confirmed/refined statements | Every edit | Sync verification, deduplication, snapshot references |

The stable ID is displayed compactly as the first 8 chars (e.g. `A1B2C3D4`); the full UUID is copyable. The content fingerprint is computed on demand and displayed as `xxxx-xxxx-xxxx-xxxx` (first 32 hex chars). Both are visible in Settings → KB Identity.

#### User model + authentication

- Each user's KB is identified by its **stable KB ID** — no account needed for local use
- Default KB is `kbase` (the existing IndexedDB name); users can create named KBs
- MCP server holds a **session token** that maps to a stable KB ID
- Self-hosted: single-user mode with optional password; no cloud account needed
- Cloud mode: Google OAuth + Drive for KB storage, keyed by stable KB ID

#### Cloud storage (Google Drive first)

- KB exported as Turtle (`.ttl`) and stored in a dedicated Drive folder: `Reckons.AI/kbs/<kb-name>.ttl`
- On sync: Drive `.ttl` is ingested as a trusted source; conflicts go to the comparison view
- Sync can be manual ("push to Drive" / "pull from Drive") or automatic on change
- Future: support S3-compatible storage as an alternative backend

#### Voice interface (Hume.AI)

- `VoiceInput.svelte` is scaffolded; Hume.AI SDK install: `npm install @humeai/voice`
- `docs/VOICE_SETUP.md` has integration notes
- Primary use case via MCP: voice note → `kb_add_note` → queued for review
- Emotion context from Hume can tag notes with affect metadata (optional enrichment)

#### Google Calendar integration

- `src/lib/google/calendar.ts` and `calendar-rdf.ts` exist; partially implemented
- MCP `calendar_today` tool should surface upcoming events with KB entity links
- e.g. "Meeting with Alice" → KB has `<urn:kbase:person/alice>` with notes, context
- Needed: end-to-end test of the OAuth → calendar fetch → RDF conversion pipeline

#### VR / AR (lower priority)

- `VRShell.svelte` and `ARShell.svelte` scaffolded, not connected to any route
- WebXR API is the integration point
- Useful once MCP is stable — spatial KB browsing as a stretch goal

---

### C — Google Colab Example Notebook

A companion Colab notebook to demonstrate the MCP server and KB query capabilities outside the web UI. Target audience: developers, researchers, and power users who want to script against their KB.

**Notebook outline:**

1. **Setup** — install `mcp` client library, set server URL + token
2. **Add notes** — `kb_add_note` examples: plain text, Turtle snippet, URL
3. **Query the KB** — `kb_query` with natural-language questions, inspect returned triples
4. **Bulk import** — load a `.ttl` file, push to KB via `kb_add_note` or direct Turtle ingest
5. **Calendar context** — `calendar_today`, show how events link to KB entities
6. **Export** — pull the full KB as Turtle, analyse with `rdflib` or `networkx`
7. **Visualise** — plot the KB graph with `matplotlib` or `pyvis`

**File location:** `colab/reckons_ai_mcp_demo.ipynb`

---

## 5. Technical Debt

| Issue | Severity | Fix |
|-------|----------|-----|
| `src/routes/api/merge-analysis.ts` missing `+` prefix | **High** — route is unreachable | Rename to `src/routes/api/merge-analysis/+server.ts` |
| `pendingStatements()` previously included merge meta-statements | Medium — fixed | Done |
| `setStatus` changelog log action uses wrong action string for `pending-removal` | Low | Update logChange in setStatus to handle new status |
| `TurtleCompanion.svelte` still in codebase | Low | Delete |
| WASM backend: `wasm-worker.ts` loading strategy needs review for production | Medium | Test with `pnpm build` |
| TurtleShell floating bubble removed | Done — session 3 | Replaced with `🐢` button in SearchBar; TurtleChatPanel rendered directly from layout |
| `.env` lacked Ollama and multi-provider variables | Done — session 3 | Added `VITE_OLLAMA_BASE_URL`, `VITE_OLLAMA_MODEL`, `VITE_PREFERRED_BACKEND`, etc. |
| `saveSettings` missing `ollamaModel`/`ollamaBaseUrl` in serialized object | Done — session 3 | Fixed in `db.ts` |

---

## 6. Architecture Notes

### Data flow
```
User / Web / Extension
  ↓ ingest
addSource() + addStatements(status='pending')
  ↓
/review — diff against confirmed, confirm/reject
  ↓
confirmedStatements() — used by graph, extension bridge, embedding
  ↓
KnowledgeGraph.svelte — 3D vis
```

### LLM providers (in order of local-first preference)
1. **Ollama** — fully local, no API key, best privacy ← recommended for self-hosting
2. **WebAssembly** — fully in-browser, no server, limited model quality
3. **Claude** — highest quality, cloud, API key required
4. **OpenAI** — high quality, cloud, API key required
5. **Gemini** — good quality, cloud, API key required

### Shelly actions routing (as of this session)
- `add_triple` → `status: 'pending'` → appears in /review **Incoming** tab
- `remove_triple` → `status: 'pending-removal'` → appears in /review **Deletions** tab
- `merge_entities` → pending meta-statement (`urn:kbase:meta/suggests-merge`) → appears in /review **Merges** tab
- `set_type` → old type: `pending-removal`, new type: `pending` → appears in both Deletions + Incoming
- `adjust_view` → immediate, no review required (view-only operation)
- `confirm_source` → immediate, sets source trust level

### Extension architecture
```
popup.ts ←→ background.ts (service worker)
              ↕ chrome.scripting.executeScript
              content-script.ts (injected into all pages)
              ↕ window.__reckonsKB (only on Reckons.AI tab)
              extension-bridge.ts (in Reckons.AI app)
```
