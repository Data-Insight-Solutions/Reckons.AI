# Reckons.AI — Roadmap

## Current State

| Property | Value |
|----------|-------|
| Status | Alpha — feature-complete for personal use |
| Data layer | Browser IndexedDB (Dexie v4) |
| Architecture | Static SvelteKit + Threlte/Three.js + N3.js + transformers.js |
| LLM backends | Claude, OpenAI, Gemini, Ollama, OpenRouter, WASM (7 total) |
| Portability | Settings profile JSON, workspace folder sync, TTL export/import |
| Identity | Stable KB UUID (device-local) + SHA-256 content fingerprint |
| Sharing | File-based only (TTL export, settings profile JSON) |
| Tests | 155+ unit/integration tests (Vitest) + Playwright E2E |

---

## Reliability Track

### R1 — Test suite
**Status: ✅ complete**

155+ tests across unit and integration layers. Coverage includes:

| Area | Tests |
|------|-------|
| `src/lib/rdf/serialize.ts` | TTL roundtrip, N-Quads output |
| `src/lib/rdf/import-ttl.ts` | Import parsing, edge cases |
| `src/lib/rdf/temporal.ts` | Conflict detection, timelines |
| `src/lib/rdf/compare.ts` | Semantic diff engine |
| `src/lib/integrations/llm/merge-analysis.ts` | Prompt building, provider routing |
| `src/lib/embed.ts` | Embedding, clustering |
| `src/lib/utils/mobile-auth.ts` | Token validation, URL building |

Framework: Vitest + jsdom for unit tests; Playwright for E2E (6 device profiles).

---

### R2 — Client-side merge analysis
**Status: ✅ complete**

`src/routes/api/merge-analysis.ts` was a server-side RequestHandler that can never execute in a `adapter-static` build. Replaced with `src/lib/integrations/llm/merge-analysis.ts` (client-side, uses provider abstraction) and updated `MergeReview.svelte`.

---

### R3 — Cost and rate awareness
**Status: ⬜ planned**

LLM calls are fire-and-forget with no usage feedback. Users can unknowingly burn through API budgets during auto-analyze or large ingestion runs.

**Plan:**
- Track token estimates per provider call (input × model rate table)
- Show cumulative session cost estimate in the notification area
- Add a "max tokens per session" guard in Settings
- Warn before triggering auto-analyze on large KBs

---

### R4 — GLB model management UI
**Status: ⬜ planned**

`glbOverrides` IndexedDB table and `setGlb()`/`clearGlb()` stores exist, but there is no browsable UI. Users cannot see which nodes have custom 3D models, remove overrides in bulk, or diagnose why a node renders incorrectly.

**Plan:**
- Table view in Settings (or a dedicated `/models` route) listing all GLB overrides
- Remove individual or all overrides
- Preview thumbnail (via Three.js offscreen canvas)
- Note in export UI that GLB assignments are not included in TTL exports

---

### R5 — Authentication for self-hosted instances
**Status: ⬜ planned**

A self-hosted instance on a home network or VPS is open to anyone who knows the URL. All KB data is readable without any access control.

**Plan (lightweight, no server required):**
- Optional passphrase field in `.env` / Settings
- On first load, prompt for passphrase; store a PBKDF2-derived key in sessionStorage
- Encrypt IndexedDB at rest using the Web Crypto API (or use Dexie encryption plugin)
- KBs with no passphrase set remain open (default behavior unchanged)

---

## Feature Track

### F1 — MCP Server
**Status: ✅ complete**

`mcp-server/` is a standalone Node.js package exposing 20 tools:

| Tool | Description |
|------|-------------|
| `kb_list_kbs` | List all available knowledge bases |
| `kb_search` | Full-text BM25 search over entities and statements |
| `kb_get_entity` | Get all statements about an entity |
| `kb_list_entities` | List all entities with type and connection count |
| `kb_stats` | KB statistics (entity count, statement count, types) |
| `kb_add_note` | Add a note for extraction and review |
| `kb_subgraph` | Extract a subgraph around an entity (configurable depth) |
| `kb_reckoning` | Run a Situation-Target-Proposal analysis |
| `kb_list_sources` | List all sources with metadata and trust scores |
| `kb_request_refresh` | Request a source refresh by source ID |
| `kb_git_status` | Show current git branch, staged/modified files, and recent commits |
| `kb_check_plan` | Check alignment of current work against the knowledge base |
| `kb_pending` | List queued proposals from pending.jsonl |
| `kb_git_diff_triples` | Cross-reference git changes with KB entities |
| `kb_alignment_score` | Quantitative alignment score (0-1) with per-dimension breakdown |
| `kb_compress` | Compress KB context for LLM prompts (~60-70% token reduction) |
| `kb_local_extract` | Extract triples from text via a local Ollama model (opt-in) |
| `kb_local_summarize` | Summarize an entity subgraph or text via a local Ollama model (opt-in) |
| `kb_generate_page` | Draft a documentation-page markdown proposal via a local Ollama model (opt-in) |
| `kb_entity_markdown` | Deterministic (no LLM) rendering of one entity as markdown |

Bridge: App auto-exports `knowledge.ttl` on each mutation (debounced 2s). MCP server reads this file via `MultiKBReader`. Pending notes written to `knowledge.pending.jsonl`, drained on app load.

---

### F2 — KB Publication (GitHub Gist)
**Status: ⬜ planned**

Allow users to publish their KB to a static URL that any browser can open in read-only mode.

At publish time, assign a **Published GUID** (distinct from the local device UUID). The published artifact is a `.ttl` file containing all confirmed statements.

**Hosting: GitHub Gist**
- User authenticates with a GitHub token (stored in settings)
- On "Publish", POST/PATCH a secret Gist containing `kb.ttl`
- The Gist raw URL becomes the `kb-url` parameter

**Shareable URL format:**
```
https://reckons.ai/?kb=<published-guid>&kb-url=<encoded-gist-raw-url>
```

---

### F3 — Read-Only Guest View
**Status: ⬜ planned** (depends on F2)

When a user opens a Published KB URL they did not create:

1. App fetches `kb-url`, parses the Turtle, renders graph in **read-only mode**
2. No ingest, no editing, no RadialMenu actions
3. View state (layout, selected entity, filters) still works via URL params
4. "Fork to my KB" button imports all statements into the user's local KB

---

### F4 — Collaborative KB
**Status: ⬜ speculative** (depends on F3)

- Published KBs can receive **statement proposals** from guests
- Owner reviews via the existing Review page workflow
- Proposals stored in a second Gist or appended section of the same `.ttl`
- Merge between two Published KBs: fetch both, run disambiguation + merge pipeline

---

### F5 — Voice Interface (Hume.AI EVI)
**Status: ✅ functional** — `ShellyVoice.svelte` wired with full mic capture pipeline

Hume SDK integrated, mic capture implemented, audio streaming works. Config via Settings.

**Remaining work:**
- Real-world testing with live Hume config
- Handle reconnection and timeout gracefully
- Surface voice activity state in the Shelly UI (animated indicator)

---

### F6 — Google Drive Sync
**Status: ⬜ scaffolded** — `src/lib/google/drive.ts` + `auth.ts` exist

OAuth flow and Drive file listing are implemented. Auto-sync on KB mutation is not wired up.

**Plan:**
- On each KB mutation (debounced 30 s), upload `kb_full.ttl` to the dedicated Google Drive folder
- On first load on a new device, detect the Drive KB and offer to restore
- This gives cross-device sync without requiring any server infrastructure

---

### F7 — VR / AR Shells
**Status: ⬜ architectural stubs**

`VRShell.svelte` and `ARShell.svelte` define the interface contract for WebXR rendering but contain no implementation. These depend on WebXR browser support maturing and Threlte XR integration.

---

### F8 — Browser Extension Research Sessions
**Status: ✅ complete**

Inspired by Semiont's Gather flow — aggregate analysis findings across multiple tabs during a research session.

| Feature | Description |
|---------|-------------|
| **Session accumulation** | Each page analysis auto-appends to a persistent research session |
| **Session tab** | New 3rd tab in sidepanel: Compare \| Session \| Ingest |
| **Aggregate summaries** | Cross-page summaries per category (new/reinforcing/conflicting) with source attribution |
| **At-a-glance bar** | Proportional colored bar showing conflict/reinforce/new ratio |
| **Per-page breakdown** | Collapsible page cards with pill counts and triple details |
| **Batch ingest** | "Ingest All New" button sends all new triples from session to KB |
| **Session management** | Clear session, remove individual pages |
| **Mobile Firefox UX** | Responsive CSS with 44px touch targets, larger fonts, bottom-friendly layout |
| **Popup session badge** | Shows session page count + conflict/new counts in popup |

Files changed: `types.ts`, `background.ts`, `sidepanel.ts`, `sidepanel.css`, `popup.ts`, `popup.css`.

---

### F8b — Browser Extension Explore Mode
**Status: ⬜ planned**

Add an explore/navigate feature to the browser extension so users can browse and interact with their KB graph directly from the extension popup or side panel, without opening the full app.

**Plan:**
- Side panel or popup view showing a lightweight 2D graph (canvas-based, subset of main graph)
- Search entities, view statements, navigate relationships
- Quick-add notes or highlights from the current page context
- Sync state with the main app via `extension-bridge.ts`

---

### F20 — n8n Cloud Sync
**Status: ✅ complete**

Private, self-hosted cloud sync and source monitoring via n8n VPS. No SaaS dependency.

| Component | n8n Workflow ID | Description |
|-----------|----------------|-------------|
| **KB Sync Hub** | `gzL6AXn9iWo4GZxN` | Upload/download/status/pending via webhooks |
| **Source Monitor** | `CvbUNSZkZVf4hJFG` | Watch URLs for changes, detect diffs, queue pending notes |

**Data tables:** `reckons_kb_store`, `reckons_watched_urls`, `reckons_pending_notes`

**Endpoints:**
- `POST /webhook/reckons-kb-upload` — upload a KB snapshot (content-hash dedup)
- `GET /webhook/reckons-kb-download?kb=name` — download latest TTL
- `GET /webhook/reckons-kb-status` — JSON summary of all stored KBs
- `GET /webhook/reckons-kb-pending?kb=name` — pending notes from source monitors
- `POST /webhook/reckons-watch-url` — add a URL to the watch list

See [`docs/N8N_INTEGRATION.md`](docs/N8N_INTEGRATION.md) for full details.

---

### F21 — Enterprise: People · Policy · Procedure
**Status: ⬜ planned**

Structure organisational knowledge around three dimensions:

| Dimension | Scope |
|-----------|-------|
| **People** | RBAC, team KBs, ownership, delegation, audit trails |
| **Policy** | Legal, cultural, and compliance constraints as graph entities |
| **Procedure** | SOPs, decision trees, process graphs — from intent to execution |

**Key decisions:**
- **Authentication:** Bring-your-own (SSO, LDAP, OIDC) — no built-in identity provider
- **Delivery:** File-based `.ttl` distribution — portable W3C standard, no platform lock-in
- **Deployment:** Self-hosted via n8n cloud sync, private AI backends, air-gapped operation
- **RBAC model:** Entity-level + graph-level permissions, not just KB-level

See [`docs/ENTERPRISE.md`](docs/ENTERPRISE.md) for the full roadmap.

---

### F22 — Entity Normalisation
**Status: ✅ complete**

Post-extraction, pre-review normalisation step in the ingest pipeline (`src/lib/rdf/normalize-entities.ts`). When new triples arrive, embedding similarity detects if incoming entity/predicate IRIs refer to concepts already in the KB and rewrites them to match the existing IRI.

| Aspect | Detail |
|--------|--------|
| **Entity threshold** | Cosine ≥ 0.90 (conservative, above semantic-diff's 0.88) |
| **Predicate threshold** | Cosine ≥ 0.88 (above semantic-diff's 0.82) |
| **Two-pass matching** | Exact label match (case-insensitive) first, then embedding similarity |
| **Perf guard** | Skips normalisation if KB has >500 unique entities |
| **Protected vocabs** | rdf:, rdfs:, skos:, xsd: IRIs are never remapped |
| **Fallback** | Returns raw statements unchanged if embeddings fail |

Pipeline position: `LLM extraction → triplesToStatements() → normalizeEntities() → computeDiff() → semanticEnrichDiff() → addStatements()`

---

### F23 — Self-Dogfooding MCP Workspace
**Status: ✅ complete**

Reckons.AI uses its own MCP server to track product state. Three internal KBs are symlinked from `static/*.ttl` into `mcp-workspace/kbs/`:

| KB | Source TTL | Content |
|----|-----------|---------|
| **Roadmap** | `reckons-roadmap.ttl` | Feature status, planned work, design decisions |
| **Production** | `reckons-production.ttl` | Tech stack, test suite, architecture |
| **Features** | `docs-features.ttl` | User-facing feature documentation |

Claude Code is configured (`.claude/settings.local.json`) to start the MCP server automatically and query these KBs before planning work. Edit a TTL file → MCP server auto-reloads → next AI session sees the change.

Setup: `bash scripts/setup-mcp-workspace.sh`

---

## Implementation Notes

### Published GUID assignment
```typescript
const publishedGuid = crypto.randomUUID();
await db.settings.put({ key: 'publishedKbGuid', value: publishedGuid });
```

### MCP token generation
```typescript
const mcpToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
  .map(b => b.toString(16).padStart(2, '0')).join('');
```

### Gist publish flow (pseudocode)
```typescript
async function publishToGist(token: string, existingGistId?: string): Promise<string> {
  const ttl = await getTurtleString();
  const body = { description: 'Reckons.AI KB', public: false, files: { 'kb.ttl': { content: ttl } } };
  const url = existingGistId ? `https://api.github.com/gists/${existingGistId}` : 'https://api.github.com/gists';
  const res = await fetch(url, {
    method: existingGistId ? 'PATCH' : 'POST',
    headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const gist = await res.json();
  return gist.files['kb.ttl'].raw_url;
}
```
