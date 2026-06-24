# Reckons.AI — Claude Code Instructions

## Project

This is **Reckons.AI**, a personal knowledge base app built on SvelteKit + TypeScript + Dexie (IndexedDB). The local directory name is `tripleNotes` but the product is called Reckons.AI.

## Knowledge Base Context (MCP)

This project has its own Reckons.AI MCP server configured (`reckons`). It exposes 3 knowledge bases that describe the product itself:

- **Roadmap** — Feature status, planned work, design decisions, dependencies. Check this before starting new features.
- **Production** — Tech stack, test suite health, architecture, source types, MCP tools.
- **Features** — User-facing feature documentation (ingest, review, graph, Shelly, compare, multi-KB, safety, etc.)

### When to query the KBs

- **Before planning new work**: `kb_search` the Roadmap KB for the feature area. Check if it's already planned, in progress, or done.
- **Before modifying architecture**: `kb_search` the Production KB for the component. Understand dependencies.
- **When asked about features**: `kb_search` the Features KB for how things work.
- **At the start of a session**: `kb_stats` to see current state.

### Keeping KBs up to date

The KBs are symlinked from `static/*.ttl` files in this repo. When you complete a feature or change the roadmap:

1. Update the relevant `.ttl` file in `static/` (e.g., `reckons-roadmap.ttl`, `reckons-production.ttl`, `docs-features.ttl`)
2. The MCP server watches for file changes and auto-reloads — no restart needed.

### MCP tools available

- `kb_list_kbs` — List all KBs with triple counts
- `kb_search(query, kb?)` — BM25 full-text search
- `kb_get_entity(entity, kb?)` — All triples about an entity
- `kb_list_entities(kb?)` — List all entity IRIs
- `kb_stats(kb?)` — Triple/entity/source counts
- `kb_subgraph(entity, hops?, kb?)` — N-hop neighbourhood
- `kb_reckoning(situation, target, kb?)` — AI-grounded Situation-Target-Proposal

## Code Conventions

- **CSS**: Use CSS variables (`--accent`, `--surface`, `--font-mono`, etc.) from `docs/STYLE_GUIDE.md`
- **bits-ui**: Always `:global(.unique-class)` for CSS targeting
- **Z-index scale**: node-labels=10, panels=300, Shelly=350, SearchBar=390, NavBar=400, MergeReview=500
- **LLM providers**: claude, openai, gemini, ollama, wasm, mock, manual, openrouter, chrome-ai
- **Review statuses**: pending, pending-removal, confirmed, refined, rejected, superseded
- **Embedding model**: BGE-small-en-v1.5 (33MB, 384d, q8) via `src/lib/embed.ts`
- **Content safety**: `ETHICS_PREAMBLE` injected into ALL LLM system prompts — never remove

## Testing

- Unit tests: `npx vitest run`
- Visual tests: `npx playwright test --config=playwright.visual.config.ts`
- Full local suite: `bash tests/bench/run-local-suite.sh`
- MCP server: `cd mcp-server && npm test`

## Key Directories

- `src/lib/rdf/` — Core RDF types, diff, semantic-diff, normalize-entities, serialize
- `src/lib/stores/` — Svelte 5 rune stores (kb, settings, ingest, disambiguation)
- `src/lib/integrations/llm/` — LLM backends (claude, wasm, extractor, providers)
- `src/lib/integrations/github/` — Repo ingest
- `src/lib/safety/` — Content policy, ethics preamble
- `mcp-server/` — Standalone MCP server (Node.js, N3.js)
- `static/*.ttl` — Documentation and reference KBs
- `tests/bench/` — Ollama LLM benchmarks and scoring
