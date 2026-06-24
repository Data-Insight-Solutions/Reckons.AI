# Reckons.AI — Complete User & Developer Guide

## What is Reckons.AI?

Reckons.AI is a personal knowledge graph that turns web pages, documents, and notes into a structured graph of facts — stored as a standard **Turtle** (`.ttl`) file on your device. An AI model extracts facts as triples (Subject → Predicate → Object); you review and confirm them. Over time your Turtle becomes a structured, queryable record of everything you've read and thought.

A browser extension lets you compare any web page against your Turtle in real time, highlighting reinforcing or conflicting claims directly on the page.

---

## Quick Start

### Option A — Local dev (developers)

```bash
git clone <repo>
cd tripleNotes
cp .env.example .env          # add your API key(s)
pnpm install
pnpm dev                    # http://localhost:5173
```

### Option B — Docker (one command, no Node required)

```bash
docker compose up              # http://localhost:5173
```

All data is stored in IndexedDB inside your browser. Nothing is sent to any server.

### Option C — Static hosting (Netlify / Vercel / Cloudflare Pages)

```bash
pnpm build                  # generates dist/
```

Deploy `dist/` to any static host. No backend required. The app is a pure PWA — install it from the browser for an app-like experience on desktop and mobile.

### Option D — Deno (alternative runtime)

```bash
deno run --allow-net --allow-read https://deno.land/std/http/file_server.ts dist/
```

For the dev server, Deno compatibility requires `@sveltejs/adapter-static` (already the case). Full Deno-native SSR is not currently supported.

---

## Cross-Device Use

All Turtle data lives in **browser IndexedDB**. It does not automatically sync across devices.

### Sharing your Turtle

| Method | How | Works offline? |
|---|---|---|
| Export `.ttl` (Turtle) | Settings → Export as Turtle | Yes |
| Import on another device | Ingest page → paste file/URL | Yes |
| Google Drive backup | Settings → Google → connect | No (needs OAuth) |

### Fully offline `.ttl` sharing

1. Export: **Settings → Export as Turtle** → downloads `kb-snapshot.ttl`
2. Transfer the file (USB, AirDrop, email attachment, etc.)
3. Import on another device: **Ingest → URL/file** → select the `.ttl` file

The Turtle format is a W3C standard — any RDF tool can read it.

### Google Drive vs local backup

| | Google Drive | Local `.ttl` |
|---|---|---|
| Automatic | Yes (scheduled) | Manual |
| Accessible anywhere | Yes | Requires file transfer |
| Privacy | Google can access | Your device only |
| Requires account | Yes | No |
| Works offline | No | Yes |
| Data portability | Via Drive download | Always portable |

**Recommendation:** For maximum privacy, use local `.ttl` export. For convenience across devices, Google Drive is fine — your Turtle content is stored in a `.ttl` file in your own Drive folder, not in any Reckons.AI database.

---

## AI Backends

**No API key required.** The first three options below are completely free with no account or billing.

### Manual Paste — free, any LLM

The app builds the full extraction prompt (including your Turtle context) and copies it to the clipboard. Paste it into any LLM web interface — Claude.ai, ChatGPT, Gemini, Perplexity, etc. — copy the JSON response, paste it back. The app parses and processes it exactly as if an API had been called.

- **Pros:** Works with any LLM, no account, no billing, no API keys, highest possible model quality
- **Cons:** Manual steps per ingestion

### Chrome Built-in AI (Gemini Nano) — free, local

Chrome 127+ includes Gemini Nano accessible via `window.ai.languageModel`. Runs entirely inside Chrome — no network call, no account.

Setup (one time):
1. Go to `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled** → restart Chrome
2. Go to `chrome://components` → update **Optimization Guide On Device Model**

- **Pros:** Zero setup after flag enabled, completely private, no billing
- **Cons:** Chrome-only, smaller model, quality similar to WASM

### Local WASM — free, offline

Runs a small language model (SmolLM2-360M by default) in a Web Worker via @huggingface/transformers. No account, no install, works in any browser. Used as the **automatic fallback** if a cloud backend is selected but no API key is configured.

- **Pros:** Works everywhere, zero setup, completely private
- **Cons:** Slower (15–120s), lower quality than larger models

### Ollama — free, local

Runs full-size open source models (Llama 3, Mistral, etc.) locally via [Ollama](https://ollama.com). Best free quality option.

```bash
brew install ollama       # macOS
ollama pull llama3.2
ollama serve
```

- **Hardware:** 4 GB VRAM for 7B models; 8 GB+ recommended
- **Pros:** High quality, fully offline, no account
- **Cons:** Requires Ollama installed and running

### OpenRouter — free models available

[OpenRouter.ai](https://openrouter.ai) provides a unified API with many models, several of which are free (Llama 3, Mistral, Phi, etc.). One free account unlocks all free-tier models.

Free models include: `meta-llama/llama-3.2-3b-instruct:free`, `mistralai/mistral-7b-instruct:free`

Get a key at openrouter.ai/keys — no credit card required for free-tier models.

### Gemini (Google) — free tier

Google AI Studio gives a free API key with 1,500 requests/day free. No billing required to get started.

Get a key at [aistudio.google.com](https://aistudio.google.com) — sign in with Google, click "Get API key".

### Claude (Anthropic) — recommended

- **Quality:** Highest accuracy for triple extraction. Strong reasoning about what is fact vs opinion.
- **Privacy:** Data sent to `api.anthropic.com`. Anthropic's usage policy does not train on API data by default.
- **Cost:** Usage-billed per token. A typical page analysis costs ~$0.001–$0.005 with Haiku.
- **Setup:** Requires an API key from [console.anthropic.com](https://console.anthropic.com).

Note: Claude.ai subscriptions ($20/month) do **not** include API access. The API is a separate pay-per-token product.

### OpenAI (GPT)

- **Quality:** Good. GPT-4o-mini is fast and affordable; GPT-4o is higher quality.
- **Cost:** Usage-billed. GPT-4o-mini is ~$0.00015/1K input tokens.
- **Setup:** API key from [platform.openai.com](https://platform.openai.com).

---

## Onboarding & Tutorial

First-time users are guided by **Shelly**, the turtle companion in the bottom-left of the graph view.

### Starter content

On the landing page:

- **Quick-Start Example** — a practical KB with 15 entities and 90 triples showing how real-world data maps to a knowledge graph. Import it to explore immediately.
- **Documentation Hub** — switch to the built-in docs KB (`starter-guide.ttl`) for a guided introduction. Amber-ringed **KB Leap nodes** link to 7 deep-dive sub-graphs that auto-import on first click.

### Tutorial hints

Contextual nudge notifications guide you through the workflow tabs as you use the app for the first time. Each nudge appears once and is never repeated after dismissal.

To disable tutorial hints: **Settings → Display → tutorial hints → off**. Turning hints back on also clears previously dismissed nudges so the full sequence replays.

### Shelly chat

Click the 🐢 button in the search bar to open Shelly's chat panel. Three tabs:

- **tutorial** — step-by-step walkthrough of the Turtle format, the workflow, and Reckonings
- **chat** — free-form conversation with your LLM backend, grounded in your KB. Shelly can propose new triples, edits, and deletions; review them in the Review tab before they take effect. Supports voice input via Whisper STT (mic button, no cloud required).
- **explore** — story picker chips at top + LLM-driven guided tours of your KB. Story playback with TTS via Kokoro (local) or browser speech synthesis.

---

## Browser Extension

The extension requires **Google Chrome** (or Chromium-based browsers: Edge, Brave, Arc).

### Installation

1. `pnpm build:extension` — builds to `dist/extension/`
2. Chrome → `chrome://extensions` → Enable "Developer mode"
3. "Load unpacked" → select `dist/extension/`

### Features

#### Compare Tab
Opens a side panel alongside the current web page. The AI analyzes the page against your KB and highlights:
- **Red** — claims that conflict with your KB
- **Green** — claims that reinforce your KB
- **Blue** — new knowledge not yet in your KB

Each highlighted span shows an always-visible label (subject - predicate) and a hover tooltip with full triple detail. An at-a-glance proportional bar shows the balance of new/conflicting/reinforcing information.

#### Session Tab
Accumulates findings across all pages analyzed during your research session. Shows cross-page summaries per category, per-page breakdown with conflict/new pill counts, and a batch "Ingest All New" button. Sessions persist across browser restarts.

#### Ingest Tab
Sends the page's already-extracted triples directly to your KB (no re-analysis). Requires Reckons.AI to be open in another tab. After ingesting, check **Review** to confirm or reject the new statements.

### Extension Settings

| Setting | Description |
|---|---|
| Provider | Claude / OpenAI / Gemini — which API to use for page analysis |
| API Key | Stored locally in `chrome.storage.local`, never sent except to your chosen provider |
| App URL | URL of your running Reckons.AI instance (default: `http://localhost:5173`) |
| Conflict Color | Hex color for conflict highlights (default: red `#ef4444`) |
| Reinforce Color | Hex color for reinforce highlights (default: green `#22c55e`) |
| New Color | Hex color for new-knowledge highlights (default: blue `#63b3ed`) |

---

## Main App Settings

### Backends
Select which AI provider extracts triples. API keys are stored in IndexedDB — local only.

### Auto Re-analysis
- **Re-analyze after each import** — runs one analysis pass ~1.5s after each new source is ingested
- **Analyze every N minutes** — periodic background scan for new suggestions, merges, and type assignments

### Turtle Companion
The 3D turtle assistant (Shelly). Customize personality, animation, voice, position, and click behavior.

### Entity Types
Define custom RDF types (e.g. `Person`, `Place`, `Concept`). Used to color-code graph nodes and guide AI suggestions.

### Turtle Identity
- **Stable ID** — a UUID generated once, never changes. Use for MCP routing or identifying your Turtle across devices.
- **Content Fingerprint** — SHA-256 of all confirmed triples. Changes with every edit. Use to verify two exports are identical.

### Backup & Export
Downloads a `.ttl` (Turtle) file of all confirmed statements. No data is sent anywhere.

### Display
- **Tutorial hints** — toggle contextual nudge notifications on/off

---

## Review Workflow

After ingesting a source, statements appear in **Review** with three tabs:

| Tab | Contents |
|---|---|
| Incoming | New triples pending your approval |
| Deletions | Triples flagged for removal |
| Merges | Suggested entity merges (same entity, different labels) |

For each statement: **Confirm** (add to Turtle), **Reject** (discard), or **Refine** (edit before confirming).

### Merge review

When two entities are likely the same (e.g. "Alice Smith" and "Alice"), the AI surfaces them as a merge candidate. The merge review panel shows:

- Side-by-side statement comparison for both entities
- Source trust levels for each statement
- Temporal conflict detection (same subject + predicate, different objects at overlapping times)
- An AI-powered analysis explaining differences, data loss risk, and a merge recommendation
- A follow-up chat interface for questions like "which entity has more trusted sources?"

---

## Graph View

The 3D knowledge graph shows confirmed entities as nodes, with edges for predicates.

- **Click a node** — opens the node detail panel (edit label, assign type, delete)
- **Drag-release on empty space** — opens the radial menu (up=details, down=reject, left=merge, right=create relation)
- **Filter chips** (top-left) — filter by entity type or source
- **Layout modes** — force / focus / source / type / hub
- **Label visibility** — labels fade by distance; hubs stay visible longer; closer nodes' spheres occlude labels behind them
- **History mode** (`/history`) — scrub through a timeline to see your Turtle at any past moment

---

## Reckoning

The Reckoning tab (⟁) is the decision-support feature.

1. **Situation** — describe your current context in plain language
2. **Target** — state what outcome you want
3. The AI generates a proposal grounded only in facts from your Turtle

The proposal format:
- **OVERVIEW** paragraph in plain language
- Numbered options, each with: description, what it implies, and an `Action:` field
- A "show technical details" button for the underlying triple IRIs and source IDs
- Ends with: "Ask for more: Reply 'show technical details'"

Accepted KB actions from the Reckoning are added as pending statements in Review — mark the decision as part of your Turtle's history.

---

## Voice Input

Voice input via the Hume.AI SDK is scaffolded in `src/lib/components/VoiceInput.svelte`. It is not active by default — it requires an API key and the SDK install.

### Setup

```bash
pnpm install @humeai/voice
```

1. Sign up at [hume.ai](https://hume.ai) and create an API key
2. Add it in **Settings → Hume.AI API Key**

### Implementation

The voice flow:
```
Record audio → Hume.AI stream → transcript → semantic extractor → triples → Review
```

The component needs:

```ts
import { HumeVoiceClient } from '@humeai/voice';
const client = new HumeVoiceClient({ apiKey: settings().humeAiApiKey });
const result = await client.transcribe(audioStream);
// Feed result.text through the standard extractor
```

Microphone permission is requested on first use. Voice audio is sent to Hume.AI cloud servers — a warning is shown in Settings.

---

## Developer Notes

### Architecture

```
src/
  lib/
    storage/       # Dexie IndexedDB (db.ts, backup.ts, kb-fingerprint.ts, kb-registry.ts)
    stores/        # Svelte 5 reactive stores (kb.svelte.ts, ingest.svelte.ts, settings.svelte.ts, ...)
    rdf/           # RDF types, temporal reasoning, entity types, comparison engine
    integrations/  # Third-party integrations organized by company
      llm/         # claude, openai, gemini, ollama, wasm, openrouter, whisper-stt, kokoro-tts, model-cache
      parsers/     # firecrawl, mistral-ocr
      google/      # OAuth, Calendar, Drive
      indico/      # Indico event management
      meshy/       # 3D model generation
    3d/            # Threlte (Three.js) graph, AR/VR shells
    components/    # Shared UI (NavBar, SnapPanel, TurtleChatPanel, MergeReview, ...)
    safety/        # Content policy, classifier, ethics preamble
    onboarding/    # Starter templates (templates.ts)
    extension-bridge.ts  # Exposes window.__reckonsKB for the browser extension
  extension/       # Chrome MV3 extension (background, content-script, popup, sidepanel)
  routes/
    +page.svelte          # 3D graph view with overlay UI
    ingest/               # Source ingestion
    review/               # Confirm / reject / merge pending statements
    reckoning/            # Decision-support proposal generation
    compare/              # Side-by-side Turtle diff engine
    kb/                   # Turtle management, sources, export, multiple KBs
    history/              # Timeline scrubber — read-only historical graph
    settings/             # App configuration
    api/                  # SvelteKit API endpoints (turtle-chat, re-analyze)
```

### Merge Analysis API

**Route:** `src/routes/api/merge-analysis/+server.ts`

Handles intelligent merge conflict resolution using the Claude API (model: `claude-haiku-4-5-20251001`).

**Request:**
```typescript
POST /api/merge-analysis
{
  entityKeyA: string;
  entityKeyB: string;
  statementsA: Statement[];
  statementsB: Statement[];
  sourcesInfo: { id: string; title: string; trustLevel?: string }[];
  followUpQuestion?: string;
  previousAnalysis?: string;
}
```

**Response:**
```typescript
{ analysis: string; success: boolean }
```

The endpoint enriches the prompt with:
- Historical merge decisions (acceptance rate, preferred entity size heuristics)
- Temporal conflict detection (same subject+predicate, overlapping time windows)
- Cosine similarity score between entity labels

Users can ask follow-up questions in plain English; `previousAnalysis` is passed as context for continuity.

### Environment Variables

Copy `.env.example` to `.env`:

```
VITE_ANTHROPIC_API_KEY=sk-ant-...
VITE_CLAUDE_MODEL=claude-haiku-4-5-20251001
VITE_OPENAI_API_KEY=sk-...
VITE_OPENAI_MODEL=gpt-4o-mini
VITE_GEMINI_API_KEY=AIza...
VITE_GEMINI_MODEL=gemini-2.0-flash
VITE_PREFERRED_BACKEND=claude
VITE_OLLAMA_BASE_URL=http://localhost:11434
VITE_OLLAMA_MODEL=llama3.2
VITE_WASM_MODEL=HuggingFaceTB/SmolLM2-360M-Instruct
```

Keys in `.env` are baked into the extension build at compile time and stored as defaults in `chrome.storage.local`. They are not exposed in the web app beyond the settings page (where users can override them).

### Building the Extension

```bash
pnpm build:extension        # outputs to dist/extension/
```

The extension build is separate from the app build (`vite.extension.config.ts`). Both share types from `src/extension/types.ts`.

### Testing

```bash
pnpm test:e2e               # desktop Chrome only
pnpm test:e2e:devices       # all 6 device profiles
pnpm test:e2e:mobile        # Android + iOS + tablet
pnpm test:e2e:headed        # headed Chrome (for debugging)
```

Device profiles: `desktop-chrome`, `desktop-firefox`, `desktop-safari`, `mobile-android` (Pixel 7), `mobile-ios` (iPhone 15), `tablet` (iPad Pro 11).

Firefox and Android tests run without additional system dependencies. WebKit (Safari/iOS/tablet) requires:

```bash
sudo apt-get install libavif16   # Ubuntu/Debian
npx playwright install webkit
```

### MCP Server

A standalone Node.js MCP server in `mcp-server/` exposes 11 tools to AI agents (Claude Desktop, Cursor, Claude Code, etc.):

| Tool | Description |
|------|-------------|
| `kb_list_kbs` | List all available knowledge bases |
| `kb_search` | Full-text BM25 search over KB entities and statements |
| `kb_get_entity` | Get all statements for a specific entity |
| `kb_list_entities` | List all entities with type and connection count |
| `kb_stats` | Return KB statistics |
| `kb_add_note` | Add a note for extraction and review |
| `kb_subgraph` | Extract a subgraph around an entity (configurable depth) |
| `kb_reckoning` | Run a Situation-Target-Proposal analysis |
| `kb_list_sources` | List all sources with metadata and trust scores |
| `kb_request_refresh` | Request a source refresh by source ID |
| `kb_add_triple` | Directly add a triple with subject, predicate, object |

The MCP server reads `.ttl` files from a workspace folder via `MultiKBReader`. Supports single-file legacy mode (`--kb file.ttl`) and multi-KB workspace mode (`--kb /path/to/workspace/` scanning `kbs/{name}/kb.ttl`). File watching auto-reloads on changes.

#### Self-dogfooding workspace

Reckons.AI uses its own MCP server to track product state. Run `bash scripts/setup-mcp-workspace.sh` to set up symlinks from `mcp-workspace/kbs/` to the reference TTL files in `static/`. Claude Code is configured to start the MCP server automatically and query these KBs (Roadmap, Production, Features) before planning new work.

### Multi-KB Management

Create, switch, rename, and delete independent knowledge bases from the KB page. Each KB has its own IndexedDB store, stable UUID, and content fingerprint. KB Leap allows cross-referencing entities between KBs — click a leap node to jump to the target KB (auto-imports docs sub-graphs on first click).

### Content Safety

All LLM system prompts include an ethics preamble. A content classifier (`src/lib/safety/content-policy.ts`) filters blocked content on ingest and flags mature content on export. Two levels: `blocked` (filtered out) and `mature` (flagged with advisory).

### Predicate Manager

View all predicates in your KB with usage counts. Rename predicates across all statements, or merge two predicates into one. Accessible from the KB page.
