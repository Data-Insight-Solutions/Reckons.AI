---
title: "Local VLM workflow streams"
slug: "vlm-workflow-streams"
order: 1002
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "Each stream uses fresh browser storage, synthetic UI inputs and an explicit loopback app origin."
generated: "docs-kb"
---

# Local VLM workflow streams

- Each stream uses fresh browser storage, synthetic UI inputs and an explicit loopback app origin. Network requests are limited to same-origin GET/HEAD; service workers, websocket connections, popups and downloads are unavailable. Real external integrations are outside this harness. Artifacts are private under XDG_STATE_HOME/reckons/visual-streams (default ~/.local/state), with ordered screenshots and hashes, configuration, raw model responses, validated actions, browser errors and assertion results. Run provenance records the checkout commit and dirty flag; it does not attest which build the supplied preview serves.
- Run several independent visual analysis streams against a local branch preview. A scripted stream follows configured goto, click and fill steps. An exploratory stream asks a local vision model to choose a visible control, type, scroll, press a key or finish. Each checkpoint runs separate configured analysis lenses, such as layout, readability and progress, with the preceding screenshot available for comparison. Streams run sequentially to avoid competing for GPU memory.
- The JSON version is 1. Each stream has a unique id, mode, goal, startPath and nonempty lenses (id and question). Optional model, viewport, mobile, timeoutMs and maxSteps bound a run. Scripted streams require steps; exploratory streams use screenshot-grounded actions instead. Optional assertions check an exact path or a visible unique selector, with optional contained text. Selector assertions check rendered browser state; they cannot prove a database write unless the workflow exposes that outcome.

## Why it is this way

**Honest Note**

A verified goal means configured browser assertions passed, not that the VLM's visual judgment is correct. Goal-driven exploration stops when all assertions hold. Without assertions, a model finish is unverified. Step exhaustion, malformed output, deadline and browser failures are incomplete/error results. Visual issues and uncertainty become proposals in the main workspace review queue. CLI exit 2 means failed/incomplete execution, exit 1 means visual proposals need review, exit 0 means the run completed; read each stream status. No cloud fallback and no product edits. This is a local tool, not an autonomous CI approval gate.

## Detail

**Command**

Start a preview, then OLLAMA_BASE_URL=http://localhost:11434 npm run visual:streams -- --base=http://localhost:4173. Use --list to validate and list examples, --streams=find-review to select, --model=qwen2.5vl:7b to override models, and --config=path/to/streams.json for custom workflows. scripts/visual-streams/examples.json is the executable contract example.

**Tested By**

tests/e2e/visual-streams.test.ts

<details class="log-archive"><summary>1 earlier entry</summary>

- scripts/visual-streams/__tests__/contract.test.ts

</details>
