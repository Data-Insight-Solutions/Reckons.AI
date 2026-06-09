# Contributing to Reckons.AI

Thanks for your interest in contributing. This guide covers the basics.

## Getting started

```bash
cp .env.example .env       # configure at least one AI backend (or leave blank for WASM)
npm install
npm run dev                 # http://localhost:5173
```

## Development commands

| Command | Purpose |
|---|---|
| `npm run dev` | Start dev server |
| `npm run dev:test` | Dev server with mock LLM backends (no API keys needed) |
| `npm run check` | Svelte + TypeScript type check |
| `npm run test:run` | Run unit tests (vitest) |
| `npm run test:e2e` | Run E2E tests (Playwright, desktop Chrome) |
| `npm run test:e2e:devices` | E2E across all device profiles |
| `npm run build` | Production build (static site in `build/`) |
| `npm run storybook` | Component playground on :6006 |

## Project structure

```
src/
  lib/
    3d/            Three.js / Threlte components (graph, nodes)
    components/    Svelte UI components
    llm/           LLM provider abstraction + prompt builders
    rdf/           RDF types, serialization, diffing, temporal logic
    storage/       Dexie DB schema, backup, export
    stores/        Svelte 5 reactive stores (kb, settings, etc.)
  routes/          SvelteKit pages
mcp-server/        Standalone MCP server (Node.js, separate package)
tests/
  e2e/             Playwright end-to-end tests
  visual/          Visual regression tests (Storybook screenshots)
```

## Code style

- Svelte 5 runes (`$state`, `$derived`, `$effect`) — no legacy stores
- TypeScript strict mode
- CSS scoped to components, using `var(--token)` from `global.css`
- No emojis in code unless explicitly part of the UI

## Pull request guidelines

1. Create a feature branch from `main`
2. Run `npm run check` and `npm run test:run` before submitting
3. Keep PRs focused — one feature or fix per PR
4. Include a brief description of what changed and why

## Reporting bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- Browser + OS
- Which AI backend you're using (if relevant)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
