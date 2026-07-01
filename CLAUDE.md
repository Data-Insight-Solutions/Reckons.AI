# Reckons.AI — Claude Code Instructions

## Project

This is **Reckons.AI**, a personal knowledge base app built on SvelteKit + TypeScript + Dexie (IndexedDB). The local directory name is `tripleNotes` but the product is called Reckons.AI.

## Knowledge Base Context (MCP)

This project has its own Reckons.AI MCP server configured (`reckons`). It exposes knowledge bases that describe the product itself:

- **Roadmap** — Feature status, planned work, design decisions, dependencies. Check this before starting new features.
- **Production** — Tech stack, test suite health, architecture, source types, MCP tools. Links test files via `kpred:tested-by`.
- **Features** — User-facing feature documentation (ingest, review, graph, Shelly, compare, multi-KB, safety, etc.)
- **Architecture** — Design decisions, TTL-first docs strategy, standards alignment, deployment, style conventions, markdown migration tracker.
- **Testing** — Test suite docs as interactive stories with ordered steps, screenshots, and assertions.
- **Codebase** — Module structure, file links (`kpred:has-file`), cross-KB leaps. Covers all git-tracked source files.

### When to query the KBs

- **Before planning new work**: `kb_search` the Roadmap KB for the feature area. Check if it's already planned, in progress, or done.
- **Before modifying architecture**: `kb_search` the Production KB for the component. Understand dependencies.
- **When asked about features**: `kb_search` the Features KB for how things work.
- **When touching code files**: `kb_search` the Codebase KB to see which module owns the file.
- **At the start of a session**: `kb_stats` to see current state.

### Keeping KBs up to date

The KBs are symlinked from `static/*.ttl` files in this repo. When you complete a feature or change the roadmap:

1. Update the relevant `.ttl` file in `static/` (e.g., `reckons-roadmap.ttl`, `reckons-production.ttl`, `docs-features.ttl`, `reckons-codebase.ttl`)
2. The MCP server watches for file changes and auto-reloads — no restart needed.

### MCP tools available

- `kb_list_kbs` — List all KBs with triple counts
- `kb_search(query, kb?)` — BM25 full-text search
- `kb_get_entity(entity, kb?)` — All triples about an entity
- `kb_list_entities(kb?)` — List all entity IRIs
- `kb_stats(kb?)` — Triple/entity/source counts
- `kb_subgraph(entity, hops?, kb?)` — N-hop neighbourhood
- `kb_reckoning(situation, target, kb?)` — AI-grounded Situation-Target-Proposal
- `kb_git_status(commits?, diff?)` — Current branch, staged/modified files, recent commits
- `kb_check_plan(work, commits?, kb?)` — Check work alignment against KB entities
- `kb_pending(kb?)` — List queued proposals from pending.jsonl
- `kb_git_diff_triples(ref?, kb?)` — Cross-reference git changes with KB entities
- `kb_alignment_score(ref?, work?, kb?)` — Quantitative alignment score (0–1) with per-dimension breakdown
- `kb_compress(query, budget?, hops?, kb?)` — Compressed KB context for LLM prompts (~60-70% token reduction)

### Git analysis workflow

Use `/check-plan` or the individual tools to maintain alignment between code and KBs:

- **Before starting work**: `kb_check_plan` to verify alignment with the roadmap
- **After significant changes**: `kb_git_diff_triples` to find affected KB entities
- **Before proposing KB updates**: `kb_pending` to avoid duplicates
- **Proposing updates**: `kb_add_note` with `type`/`priority`/`agent` metadata
- **Measuring alignment**: `kb_alignment_score` for a quantitative 0–1 score across 4 dimensions
- **Drift detected**: use type `'drift-warning'` + priority `'high'`

### Pre/Post review workflow

Use `/pre-review` and `/post-review` to capture KB snapshots before and after code changes:

- **Before making changes**: `/pre-review <description of planned work>` — captures a baseline snapshot of KB entities, alignment score, and test/file links
- **After making changes**: `/post-review` — compares current state against the pre-review snapshot, showing entity changes, status transitions, new test coverage, and alignment score delta
- This gives the user a structured before/after view of how code changes affect the knowledge base

### CI/CD KB Watch

The `.github/workflows/kb-watch.yml` workflow runs on every push/PR to main:

1. Builds the MCP server and sets up the workspace
2. Runs `scripts/kb-align.ts` to compare code changes against KB plans
3. Posts an alignment report as a PR comment (for PRs)
4. Writes a step summary with alignment score, discrepancies, and drift warnings
5. Saves a KB snapshot artifact for post-action comparison

The alignment score is a composite of 4 dimensions (30% coverage, 30% status alignment, 20% dependency respect, 20% scope discipline). Commits that don't match any planned KB work are flagged as unplanned.

### TTL-first documentation policy

This project uses TTL knowledge bases as the primary documentation format. **Do NOT create new docs/*.md files.** Instead:

- **For feature/design docs**: Add entities to the appropriate TTL KB (roadmap, features, architecture, integrations)
- **For code conventions**: Use inline code comments near the actual code
- **Query before reading**: Use `kb_search` to find information before reading raw files
- **Existing markdown**: `docs/*.md` files are being migrated to TTL. Check `kb_search("migration status", kb="architecture")` for current state
- **Must stay markdown**: CLAUDE.md, MEMORY.md, .claude/commands/*.md, README.md, CONTRIBUTING.md (system requirements)

### KB predicates convention

- `kpred:tested-by` — Links a Production KB feature entity to its test file (repo-relative path, e.g., `src/lib/rdf/__tests__/diff.test.ts`)
- `kpred:has-file` — Links a Codebase KB module entity to its source files (repo-relative path)
- `kpred:has-status` — Feature lifecycle: `speculative` → `planned` → `scaffolded` → `functional` → `production`
- `kpred:depends-on` — Feature dependency (alignment scoring checks these are met)

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
- KB alignment: `npx tsx scripts/kb-align.ts --skip-e2e`
- KB snapshot: `npx tsx scripts/kb-snapshot.ts --output snapshot.json`

## Claude Code Commands

- `/check-plan` — Check current work against KB alignment (score + drift)
- `/kb-align` — Run tests, compare results against Production KB, write pending entries
- `/pre-review <work>` — Capture KB snapshot before code changes
- `/post-review` — Compare current state against pre-review snapshot

## Key Directories

- `src/lib/rdf/` — Core RDF types, diff, semantic-diff, normalize-entities, serialize
- `src/lib/stores/` — Svelte 5 rune stores (kb, settings, ingest, disambiguation)
- `src/lib/integrations/llm/` — LLM backends (claude, wasm, extractor, providers)
- `src/lib/integrations/github/` — Repo ingest
- `src/lib/safety/` — Content policy, ethics preamble
- `mcp-server/` — Standalone MCP server (Node.js, N3.js)
- `static/*.ttl` — Documentation and reference KBs
- `tests/bench/` — Ollama LLM benchmarks and scoring
- `scripts/` — KB alignment, snapshot, and workspace setup scripts
