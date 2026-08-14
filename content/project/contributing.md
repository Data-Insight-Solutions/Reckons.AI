---
title: "Contributing"
slug: "contributing"
order: 8
section: "Project"
template: doc
status: published
nav: sidebar
excerpt: "How this repository is developed and tested — for people changing the code, not using the app."
generated: "docs-composed"
---

# Contributing

How this repository is developed and tested — for people changing the code, not using the app.

## Coding workflow

### Agent orchestration — bring your own harness (PLANNED, not built)

THIS DOES NOT EXIST YET. The design: a task is a triple — goal, tier, harness preference, due-at, blocked-by, outcome — and any harness can drain the queue: Claude Code, Codex, a local Ollama script, or a human in the review queue. The graph becomes the orchestration config, so the queue outlives whichever agent CLI is fashionable this quarter, and a harness that hits a usage limit hands its task back rather than stalling it forever.

### Agents ask the graph, not you

When an agent needs a decision it cannot make, it does not stop and wait for you. It emits the question AS A PARTIAL FACT into the graph — subject and predicate known, object '?', plus a note on what the question blocks — and moves to the next unblocked task. You answer whenever you like, in the review queue. The answer flows back and the waiting work resumes.

### Check your work against the plan (git analysis)

The graph knows what you INTENDED. Git knows what you DID. Git analysis compares them: kb_check_plan tells you whether the work you are about to do matches something planned; kb_git_diff_triples finds which graph entities your diff actually touched; kb_alignment_score gives a 0-1 score across four dimensions (coverage, status alignment, dependency respect, scope discipline). Commits that match no planned work are flagged as unplanned — not blocked, but not invisible either.

### CI/CD graph watch — the plan reviews your PR

On every push and pull request, CI compares the code changes against the plan in the graph and posts an alignment report as a PR comment: score, discrepancies, drift warnings, and a KB snapshot artifact. Drift is surfaced where the review already happens, rather than in a dashboard nobody opens.

### Coding workflow

Reckons.AI turns a codebase into a graph you can interrogate, and then keeps the code and the plan honest with each other. The plan lives in the graph; code is checked against it; agents propose, humans decide. This page is generated from that same graph, so it cannot claim a capability the graph does not have.

### Consistency comes from YOUR context, not from a better model

The facts that did the work in that session were not general knowledge, and no model would have produced them from training. 'Granularity breeds rubber-stamping — a review list that is too fine trains the human to accept all.' 'Cleaning is itself damaging; an automated tidy-up that drops a fact you needed is worse than the mess.' 'Spend attention on disagreement, not agreement.' 'Unclassified fails toward the human.' These are one person's judgments, formed on this project, written down once. Because they were in the graph, they constrained work months later — an accept-all control shipped WITH outlier highlighting rather than without it, because the graph objected.

### Feed an agent the graph, not the repo

kb_compress selects the relevant subgraph for a question and serializes it compactly, so an agent gets grounded context instead of a directory listing.

### Ingest a repository into a graph

Point Reckons.AI at a repository and it builds a Codebase graph: modules, their source files (kpred:has-file), and the relationships between them. The result is queryable — 'which module owns this file', 'what does this depend on' — instead of grep and hope.

### One report that grows, instead of twenty that interrupt

Agents append findings — bug found, claim falsified, shipped, decision needed — to a single dated digest while you are away, and each finding is also written into the graph as a pending fact on the entity it concerns. You come back to one accumulating page, not a scrollback to reconstruct.

### One session, five features not rebuilt

Five requests arrived across a single session on 2026-07-19, each framed as new work — and every one of them had already been decided months earlier. The agent had no memory of those sessions; the graph did: (1) 'summarize a node and its relations' was the unbuilt remainder of F65 entity sets, F96 quick graph settings and the graph-legibility condensation idea; (2) 'group review triples and accept a set' was loop-job-grouping, which already specified batch accept with outlier highlighting — only the topical-relevance axis was genuinely new; (3) 'graphs need HNSW-style jumps to sub-graphs' met hierarchy-nav (layers within a graph) and KBLeap (jumps between graphs), narrowing the work to the one missing middle rung; (4) 'find the most relevant graph for this ingest' met routeQuestion(), already built and tested, needing only a generalized input; (5) the AI-council merge met loop-subagent-graphs, which had already established that a sub-agent returns a graph and that merging graphs is the product.

### Task scheduling in the graph (PLANNED, not built)

THIS DOES NOT EXIST YET. Tasks, schedules and outcomes as graph facts, drained by whichever runner is available — the in-app worker on any device, an optional desktop process, or the MCP server when an agent is already connected.

### The local agent tier — a first pass that never touches your source

A local model (via Ollama, on your own hardware) reviews a diff, drafts a missing description, or reads for staleness — always inside a scripted harness: ground it in the graph, constrain the prompt, validate the output, emit a PROPOSAL. It writes to the review queue. It never writes to source, and it never writes to the graph.

### The saving is not compression — it is the feature you did not build twice

The usual pitch for a knowledge graph in front of a coding agent is token compression: feed a dense subgraph instead of re-reading the repo. That saving is real but modest. The larger one is structural — an agent that can query what you already decided proposes an EXTENSION to an existing feature instead of a new feature under a slightly different name. A duplicate feature is not a one-off cost: you pay to build it, then pay forever to maintain two things that should have been one, and the second one drifts from the first the first time either is tuned.

### The script tier — checks that cannot hallucinate

Deterministic checks that run on every push and cost nothing: graph invariants (dead file links, invalid statuses, duplicate IDs, dangling dependencies); evidence for status claims (a feature marked shipped must link a test or declare that it has none — you may ship untested code, but not silently); prompt/safety-preamble drift; production-build verification; and a license gate on every third-party dependency we study.

### Work tiering — stop paying frontier prices for rules

Every recurring task is routed to the cheapest tier that can do it correctly. SCRIPT: the answer is checkable by a rule ('does this path exist', 'is this status in the enum') — deterministic code, zero tokens, zero hallucination, runs in CI. LOCAL AGENT: the answer is judgment over language and being wrong is cheap, because the output is a proposal a human gates — a local model inside a scripted harness that grounds it, validates its output, and emits a reviewable proposal. FRONTIER: cross-file architectural reasoning, deciding process, and code that lands.

## Testing

### Graph Management Page

The /kb page showing the graph registry, predicate manager, and workspace controls.

### Ingest Page

The /ingest page with text, URL, file, and graph import tabs. Verified for correct tab rendering and input field visibility.

### Main Page (Empty graph)

The graph view with an empty knowledge graph. Should show the empty state message and Shelly greeting, not a blank screen.

### Main Page (Mobile)

Main graph view on mobile viewport (375x812). NavBar collapses to hamburger, graph fills screen, touch targets are 44px minimum.

### Main Page (Tablet)

Main graph view on tablet viewport (768x1024). Intermediate layout between mobile and desktop.

### Page Screenshots

Baseline visual regression screenshots for each major page. These are not stories but single-page captures used for pixel analysis and DOM overlap detection.

### Reckons.AI Graph Review — Goal & Workflow

The Reckons.AI Graph Review is an offline, exhaustive audit of the whole app treated as a graph: every button is clicked, every screen is visually checked, and every finding is tied back to the graph for human review. It runs locally and Opus-reviewed — no cloud dependency — and scores against the Web/Mobile UI-UX rubric.

### The goal

Catch the failures a "click everything, flag crashes" pass misses — silent no-ops (a control that fires, throws nothing, and does nothing) and stale-cache regressions — while producing a reviewable, graph-native record rather than a throwaway log.

### Workflow overview

1. **Enumerate** — collect every interactive element on every route (buttons, tabs, leap badges, sheets).
2. **Act and assert a delta** — click each, then check that something observable actually changed (URL, node count, graph id, open panels, title, visible text). This is what catches silent no-ops.
3. **Visual check** — pixel, DOM-overlap and touch-target checks run locally; a local VLM scores each screenshot against the rubric.
4. **Persistent-context pass** — replay against a warm service worker to surface stale-cache regressions that fresh runs never reproduce.
5. **Tie to the graph** — each route becomes a TestWorkflow and each click a TestStep, carrying its screenshot, a pass/fail verdict, and a citation to any rubric guideline it violates; findings queue as pending facts for review.
6. **Review and grow** — Opus reads the coverage gaps and authors new predetermined paths, so the library grows over time.

This page is the goal and workflow overview; the stepped review itself is generated as a TestWorkflow story.

### Review Page (Mobile)

The /review page on mobile viewport. Stacked layout with review panel full-width above graph. Touch-friendly card actions.

### Review Split View

The /review page with the graph preview and review panel side by side. Diff entries, summary chips, and tab navigation all visible.

### Settings Page

The /settings page with LLM backend selection, API key inputs, model configuration, and export options.

### Test Suite

Reckons.AI test infrastructure: 336+ unit tests (Vitest + jsdom), Playwright E2E with 6 device profiles, visual regression with pixel analysis + DOM overlap + text presence checks, optional Mistral OCR and Claude Vision tiers. All tests run locally without API keys.

See also: [Start here](/docs/learn/start-here)

### Unit Tests

336+ tests via Vitest with jsdom environment. Coverage: RDF serialize/import, temporal conflict detection, semantic diff, merge analysis, content safety (28 tests), embedding, mobile auth. Run: npx vitest run.

### User Story Tests

End-to-end test scenarios that follow real user workflows. Each story imports graphs, navigates pages, takes screenshots at each step, and verifies UI state. Three stories: Dev Sprint Planning, User Docs Import, Cross-Graph Alignment.

### Visual Regression Tests

Playwright-based visual regression. 5 analysis layers (cheapest first): pixel analysis (solid fill, color anomaly), DOM overlap detection, text presence checks, Mistral OCR (if API key), Claude Vision semantic analysis (if API key). Screenshots saved to tests/visual/screenshots/.
