# Reckons.AI

A personal knowledge graph that turns documents, web pages, and notes into a structured graph of facts — stored as a standard **Turtle** (`.ttl`) file on your device.

You own the file. You review and confirm every fact. Nothing leaves your device unless you choose to share it.

---

## What it does

```
note / url / doc / .ttl
        │
        ▼
   AI extraction
        │
        ▼
   Review & confirm  ←── only what you approve enters your Turtle
        │
        ▼
   3D knowledge graph   Reckoning (decision support)   Share .ttl
```

1. **Ingest** — paste a note, URL, document, or an existing `.ttl` file from someone else
2. **Review** — confirm or reject each proposed triple; refine labels before accepting
3. **Explore** — 3D force-directed graph with hub emphasis, layout modes, and filter chips
4. **Reckon** — describe a situation and a target; the AI proposes options grounded in your Turtle
5. **Share** — export `.ttl` and send it to collaborators; they see the diff on import

---

## Quick start

```bash
cp .env.example .env   # add at least one AI backend key (or leave blank for WASM)
npm install
npm run dev            # http://localhost:5173
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
| **WASM (built-in)** | Free | 100% local | Low–medium |
| **Ollama** | Free | 100% local | High |
| **Chrome built-in AI** | Free | Local (Chrome only) | Medium |
| **OpenRouter** | Free tier available | Third-party | High |
| **Gemini** | Free tier (1,500 req/day) | Google | High |
| **Claude** | Pay-per-token | Anthropic | Highest |
| **OpenAI** | Pay-per-token | OpenAI | High |
| **Manual paste** | Free | Any LLM | Any |

Full setup details in [`docs/GUIDE.md — AI Backends`](docs/GUIDE.md#ai-backends).

---

## Tech stack

- **SvelteKit 2 + Svelte 5** (runes) — frontend framework
- **Threlte 8 / Three.js** — 3D force-directed knowledge graph
- **Dexie** — IndexedDB persistence (all data stays in-browser)
- **N3.js** — W3C RDF/Turtle parsing and serialization
- **Transformers.js** — local WASM LLM and embedding inference
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
}
```

Exported as standard Turtle (`.ttl`) — readable by any RDF tool.

---

## Documentation

| Doc | Contents |
|---|---|
| [`docs/GUIDE.md`](docs/GUIDE.md) | Full user + developer guide — backends, settings, review, graph, voice, merge, architecture |
| [`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md) | Dependency health, browser support matrix, replacement candidates |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Known CVEs, risk assessments, vulnerability response process |
| [`docs/USER_STORIES.md`](docs/USER_STORIES.md) | Collaborative use case scenarios (float trip, home project, research, emergency prep) |

---

## Things that are deliberately absent

- **No backend server** — all state in IndexedDB; Turtle export for backup
- **No accounts** — your Turtle is yours alone, on this device
- **No analytics, no tracking, no remote logging**
- URL ingestion proxies through `r.jina.ai/<url>` for clean-text extraction; use the note or document tab to avoid that hop entirely
