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
| @huggingface/transformers | Apache 2.0 | In-browser ML (local LLM + embeddings) |
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

## 4. Roadmap & Feature Status

### A — Comparison View --- COMPLETE

Full comparison surface at `/compare`. Diff engine (`src/lib/rdf/diff.ts`) categorizes changes as Add, Reinforce, Conflict, Merge, Remove. Visual Venn diagram, diff table with action buttons, and LLM-generated diff summaries (`src/lib/rdf/diff-summary.ts`). Integrated in `/compare`, `/review`, and browser extension sidepanel.

### B — MCP Server --- COMPLETE

Standalone Node.js MCP server in `mcp-server/`. 11 tools: `kb_list_kbs`, `kb_search` (BM25), `kb_get_entity`, `kb_list_entities`, `kb_stats`, `kb_add_note`, `kb_subgraph`, `kb_reckoning`, `kb_list_sources`, `kb_request_refresh`, `kb_add_triple`. Multi-KB support via `MultiKBReader`. Reads `knowledge.ttl` from workspace folder. Pending notes arrive via `knowledge.pending.jsonl`.

### C — Google Colab Example Notebook --- NOT STARTED

Planned companion notebook to demonstrate MCP server integration from Python. File location: `colab/reckons_ai_mcp_demo.ipynb`.

### D — Multi-KB Management --- COMPLETE

KB registry (`src/lib/storage/kb-registry.ts`), switching, KB Leap cross-references, import-as-new-KB, per-tab KB support via URL `?kb=` param or sessionStorage.

### E — Extension Research Sessions (F8) --- COMPLETE

Session accumulation across tabs, aggregate summaries, at-a-glance bar, batch ingest, mobile Firefox responsive CSS.

### F — Passage Grounding (F9) --- COMPLETE

`excerpt` field on Statement. LLM prompt rule requests verbatim source sentence. Persists via `meta:excerpt` in TTL reification. Displayed in StatementCard and DiffEntry.

### G — Enrichment Pipeline (F10) --- NOT STARTED

Progressive analysis inspired by Semiont. Reserved for future development.

### H — Diff Summary (F11) --- COMPLETE

`src/lib/rdf/diff-summary.ts` generates 3-part summaries (new/reinforcing/conflicting). Integrated in `/compare`, `/review`, and browser extension sidepanel.

### I — Predicate Manager (F12) --- COMPLETE

`PredicateManager.svelte` on `/kb` page. View all predicates with counts, rename, merge.

### J — Content Safety --- COMPLETE

`src/lib/safety/content-policy.ts`. Ethics preamble in all LLM prompts. Content classifier (blocked/mature/none). Export advisory.

### K — Whisper STT --- COMPLETE

`src/lib/integrations/llm/whisper-stt.ts`. Local speech-to-text via transformers.js. Mic button in chat tab.

### L — Kokoro TTS --- COMPLETE

`src/lib/integrations/llm/kokoro-tts.ts`. Local text-to-speech for story walkthroughs.

### M — Model Cache Management --- COMPLETE

`src/lib/integrations/llm/model-cache.ts`. Inspect, sideload, purge locally cached WASM models. Model manifests for SmolLM2-360M, MiniLM-L6-v2, Kokoro 82M, Whisper Tiny.

### N — Cross-KB Alignment (F16) --- COMPLETE

`src/lib/rdf/cross-kb-align.ts`. Align tab in review page. Entity matching (exact IRI + embedding similarity). IRI remapping + `computeDiff()`. `applyAlignmentToActiveKb()` for accept.

### O — GitHub Repo Ingest (F14) --- COMPLETE

`src/lib/integrations/github/repo-ingest.ts`. Source kind `'repository'`. GitHub REST API tree walk, file content fetch, delta compare. Code-aware extraction supplement.

### P — Source Refresh (F15) --- COMPLETE

`src/lib/stores/source-refresh.ts`. Generic refresh for url/repository/calendar sources. Auto-refresh on open + interval. MCP tools: `kb_list_sources`, `kb_request_refresh`.

### Q — n8n Cloud Sync (F20) --- COMPLETE

Private cloud sync via self-hosted n8n VPS. KB Sync Hub (upload/download/status/pending) + Source Monitor (URL watching, change detection, pending notes). See `docs/N8N_INTEGRATION.md`.

### R — Enterprise: People · Policy · Procedure (F21) --- PLANNED

RBAC, BYOA auth (SSO/LDAP/OIDC), file-based `.ttl` delivery, policy and procedure as graph entities. See `docs/ENTERPRISE.md`.

### S — Entity Normalisation (F22) --- COMPLETE

`src/lib/rdf/normalize-entities.ts`. Post-extraction IRI rewriting using embedding similarity (0.90 entity, 0.88 predicate). Two-pass matching: exact label then cosine. Prevents duplicate entities from entering the review queue. Perf guard at 500 entities. Protected standard vocabularies.

### T — Self-Dogfooding MCP Workspace (F23) --- COMPLETE

`mcp-workspace/kbs/` with 3 symlinked KBs (Roadmap, Production, Features) from `static/*.ttl`. Claude Code configured via `.claude/settings.local.json` + `CLAUDE.md`. Setup script: `scripts/setup-mcp-workspace.sh`. MCP server auto-reloads on TTL file changes.

### Future / Scaffolded

- **VR / AR**: `VRShell.svelte` and `ARShell.svelte` scaffolded, not connected to routes
- **Hume.AI Voice**: `VoiceInput.svelte` scaffolded, requires SDK install
- **Google Drive sync**: Google Drive integration exists; full sync workflow not yet end-to-end
- **VS Code Extension**: Design doc at `docs/VSCODE_EXTENSION.md`, not yet implemented

---

## 5. Technical Debt

| Issue | Severity | Status |
|-------|----------|--------|
| `src/routes/api/merge-analysis.ts` missing `+` prefix | **High** — route is unreachable | Rename to `+server.ts` |
| Orphaned `TurtleCompanion.svelte` | Low | Delete |
| Orphaned `AtmosphericField.svelte` (commented out) | Low | Delete or re-enable |

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
1. **Ollama** — fully local, no API key, best privacy
2. **WebAssembly** — fully in-browser via @huggingface/transformers, default SmolLM2-360M
3. **Chrome AI** — Gemini Nano via Prompt API, Chrome-only
4. **Claude** — highest quality, cloud, API key required
5. **OpenAI** — high quality, cloud, API key required
6. **Gemini** — good quality, cloud, API key required
7. **OpenRouter** — unified API, free tier available
8. **Manual paste** — works with any LLM web interface
9. **Mock** — dummy responses for testing

Per-task backend overrides: `ingestBackend`, `analyzeBackend`, `chatBackend`, `diffSummaryBackend`, `mergeAnalysisBackend`

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
