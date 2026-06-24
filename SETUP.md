# Reckons.AI — Setup Guide

## Overview

Reckons.AI is a personal knowledge graph that runs entirely in the browser. All data is stored locally in IndexedDB (no server required). LLM features can use cloud APIs or run fully offline via Ollama or WebAssembly.

---

## Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 18 | Build toolchain |
| pnpm | ≥ 8 | Package manager (`npm i -g pnpm`) |
| A modern browser | Chrome 120+ / Firefox 113+ | WebGL, IndexedDB, Web Workers |

Optional for local LLM:
- [Ollama](https://ollama.com) — run models like Llama 3.2 locally (no API key needed)

---

## Web App (Development)

```bash
git clone <repo-url> && cd tripleNotes
pnpm install
pnpm dev            # starts at http://localhost:5173
```

### Environment variables (optional)

Copy `.env.example` to `.env` and fill in the values you need:

```bash
cp .env.example .env
# edit .env with your API keys and preferences
```

`VITE_` variables are baked into the build at compile time — they set the initial defaults that appear the first time you open the app. After that, settings live in IndexedDB and are updated via the Settings page.

See `.env.example` for the full list with documentation. At minimum you need one API key or a running Ollama instance.

### Production build

```bash
pnpm build          # outputs to dist/
pnpm preview        # preview the production build locally
```

The output is a static site — deploy to any static host (Netlify, Vercel, a Raspberry Pi running nginx, etc.).

---

## Browser Extension

### Build

```bash
pnpm build:extension      # one-time build → dist/extension/
pnpm dev:extension        # watch mode (rebuilds on file change)
```

### Install in Chrome / Edge / Brave

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `dist/extension/` folder
5. Click the extension icon → **Options** → set your API provider and the URL where Reckons.AI is running

### Using the Extension

The extension has three tabs in the side panel:

- **Compare** — Analyze the current page against your KB. Shows new, conflicting, and reinforcing information with at-a-glance proportional bar. Supports focus prompts and manual LLM paste workflow.
- **Session** — Aggregates findings across all pages analyzed during your research session. Shows cross-page summaries per category, per-page breakdown with pill counts, and a batch "Ingest All New" button. Sessions persist across browser restarts.
- **Ingest** — Send extracted triples to Reckons.AI (requires the app to be open).

On **Firefox for Android**, the side panel opens as a full tab (the sidePanel API is not available). The UI is optimized for mobile with larger touch targets and responsive layout.

### Install in Firefox Desktop

1. Open `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on**
3. Navigate to `dist/extension/` and select `manifest.json`
4. The extension is active until Firefox restarts (temporary install)

For persistent install on Firefox, the extension must be signed by Mozilla. To test across sessions, use **Firefox Developer Edition** or **Nightly** with `xpinstall.signatures.required` set to `false` in `about:config`.

### Install in Firefox for Android (Fenix 113+)

Firefox for Android supports MV3 extensions via the [Custom Add-on Collection](https://support.mozilla.org/en-US/kb/extended-add-ons-support-firefox-android) flow:

1. Build the extension: `pnpm build:extension`
2. Create a Mozilla account at accounts.firefox.com
3. Upload the extension ZIP to [addons.mozilla.org](https://addons.mozilla.org) as an **unlisted** extension (for personal use) or submit for review
4. On your Android device: Firefox → **Settings** → **About Firefox** → tap the Firefox logo 5× (enables developer mode)
5. Go to **Settings** → **Custom Add-on Collection** → enter your AMO user ID and collection name
6. Your extension will appear in Add-ons

Alternatively, use Firefox for Android Nightly and sideload via USB debugging.

---

## LLM Configuration

Open Settings (⌖ in the nav) → **backends** tab.

### Cloud providers (require API key)

| Provider | Model | Sign-up |
|----------|-------|---------|
| Anthropic Claude | claude-haiku-4-5-20251001 (fast/cheap) or claude-sonnet-4-6 | console.anthropic.com |
| OpenAI | gpt-4o-mini | platform.openai.com |
| Google Gemini | gemini-2.0-flash | aistudio.google.com |

API keys are stored only in IndexedDB on your device and sent only to the respective provider's API endpoint.

### Ollama (fully local, no API key)

Best for privacy and offline use.

```bash
# Install Ollama (macOS/Linux)
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model (choose based on your RAM)
ollama pull llama3.2        # ~2GB, good balance
ollama pull llama3.2:1b     # ~1.3GB, fastest
ollama pull mistral         # ~4GB, strong reasoning
ollama pull qwen2.5:7b      # ~4.7GB, excellent for structured output

# Start the server (auto-starts on install)
ollama serve
```

Then in Reckons.AI Settings → select **ollama (local)** → set base URL to `http://localhost:11434` → set model name.

**CORS note**: If Reckons.AI is served from a domain other than localhost, configure Ollama to allow cross-origin requests:

```bash
OLLAMA_ORIGINS="https://your-domain.com" ollama serve
```

### WebAssembly (in-browser inference)

Select **local wasm** in settings. On first use, the model is downloaded from Hugging Face (~400MB–2GB depending on model) and cached in the browser. Inference runs in a Web Worker. No data leaves the device. Slower than Ollama for large models.

Default model: `HuggingFaceTB/SmolLM2-360M-Instruct` (~370MB). Configurable in Settings.

---

## Self-hosting (Raspberry Pi / Home Server)

```bash
# Build the web app
pnpm build

# Serve with any static server
npx serve dist/         # quick test
# or nginx / caddy for production

# For Ollama on the same machine
ollama serve &
OLLAMA_ORIGINS="http://your-pi-ip:5173" ollama serve
```

Access from any device on your local network at `http://your-pi-ip:<port>`.

---

## Portability — Moving Between Browsers and Devices

All application data lives in the browser's IndexedDB — it is browser-specific and device-specific by default. Here is how to carry your setup across:

### Knowledge Base (statements + sources)
Export as Turtle RDF from **Settings → Backup & Export**, then import on the new device via **Ingest → Import Turtle**.

- **Clean export** (`.ttl`) — confirmed triples only, standard RDF, best for interop
- **Full export** (`.ttl`) — all statements with status/confidence, round-trips perfectly
- GLB 3D model overrides are _not_ stored in the TTL and must be re-applied manually

### Settings (backends, models, UI preferences)
Use **Settings → My Defaults → Settings Profile** to export a `reckons_profile_YYYY-MM-DD.json` file. This contains all model preferences and UI settings but **no API keys**. Import it on the new browser/device to recreate your setup instantly.

API keys must always be entered manually on each device/browser — they are never exported.

### Workspace folder (cross-browser sync without accounts)
The easiest cross-browser/cross-device workflow:

1. Set your workspace folder to a cloud-synced directory (Dropbox, iCloud Drive, OneDrive, etc.) — **Settings → Local Workspace**
2. **Settings → Local Workspace → save to folder** writes `settings_profile.json` there
3. On any other browser or device: pick the same synced folder → **load from folder** to instantly restore your settings

The TTL export can also be auto-saved to the same folder (**Settings → Backup & Export → auto-save to file**), making the workspace folder a complete portable snapshot of your KB.

### My Defaults snapshot
**Settings → My Defaults → save current** stores a quick-revert snapshot in the current browser. Useful for experimenting with settings while keeping a one-click restore point. The snapshot stays in IndexedDB and is separate from the shareable profile.

---

## Multi-KB Setup

Reckons.AI supports multiple independent knowledge bases. In the KB page (☷ in nav) → click **+ new KB** → name it → it opens in a fresh context. Switch between KBs from the same page. Each KB has its own IndexedDB store.

---

## MCP Workspace Setup (Self-Dogfooding)

Reckons.AI uses its own MCP server to track product state. Three internal KBs (Roadmap, Production, Features) are symlinked from `static/*.ttl`.

```bash
bash scripts/setup-mcp-workspace.sh   # creates symlinks + meta files
```

This is pre-configured for Claude Code (`.claude/settings.local.json` starts the MCP server automatically). For other MCP-compatible tools, point them at:

```bash
node mcp-server/dist/index.js --kb mcp-workspace
```

---

## Testing Checklist (new device)

- [ ] App loads at localhost:5173
- [ ] Ingest a web page via /ingest
- [ ] Pending statements appear in /review
- [ ] Confirm some statements
- [ ] Graph shows confirmed entities at /
- [ ] Shelly is visible and opens chat on click
- [ ] Shelly responds (check API key in Settings)
- [ ] Search bar returns results; "ask Shelly" appears for unknown queries
- [ ] Create a second KB via /kb → "+ new KB"
- [ ] Switch between KBs from the KB page
- [ ] Export KB as .ttl from Settings → Backup & Export
- [ ] /compare shows diff when importing a .ttl file
- [ ] /reckoning generates a Situation-Target-Proposal
- [ ] Extension installed and side panel loads
- [ ] Extension "compare" analyzes page against KB
- [ ] Extension "session" accumulates findings across tabs

---

## Troubleshooting

**"Shelly disappears after graph loads"** — Known compositor issue on some GPU drivers. The `will-change: transform` CSS should fix it. If not, try disabling GPU acceleration in your browser.

**"KB gives 500"** — Usually an SSR issue when running `pnpm dev` and visiting /kb. The localStorage guards in `kb-registry.ts` should prevent this; if you see it, hard-reload.

**Ollama connection refused** — Ensure `ollama serve` is running. Check `http://localhost:11434` in a browser — you should see `"Ollama is running"`.

**Extension not finding Reckons.AI tab** — Make sure the app is open in a tab and the URL matches the one set in Extension Options.

**IndexedDB full** — The browser limits IndexedDB to a percentage of disk space. Export your KB (Settings → Export as Turtle) then clear the database via browser DevTools → Application → IndexedDB.
