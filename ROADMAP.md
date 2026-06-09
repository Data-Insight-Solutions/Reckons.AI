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

`mcp-server/` is a standalone Node.js package exposing 6 tools:

| Tool | Description |
|------|-------------|
| `kb_search` | Full-text search over entity labels |
| `kb_get_entity` | Get all statements about an entity |
| `kb_stats` | KB statistics (statement/source counts) |
| `kb_list_entities` | List all entities with statement counts |
| `kb_add_note` | Ingest a note (via pending pipeline) |
| `kb_reckoning` | Trigger re-analysis of KB |

Bridge: App auto-exports `knowledge.ttl` on each mutation (debounced 2s). MCP server reads this file. Pending notes written to `knowledge.pending.jsonl`, drained on app load.

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

### F8 — Browser Extension Explore Mode
**Status: ⬜ planned**

Add an explore/navigate feature to the browser extension so users can browse and interact with their KB graph directly from the extension popup or side panel, without opening the full app.

**Plan:**
- Side panel or popup view showing a lightweight 2D graph (canvas-based, subset of main graph)
- Search entities, view statements, navigate relationships
- Quick-add notes or highlights from the current page context
- Sync state with the main app via `extension-bridge.ts`

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
