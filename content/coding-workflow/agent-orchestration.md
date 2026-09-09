---
title: "Agent orchestration — bring your own harness (PLANNED, not built)"
slug: "agent-orchestration"
order: 11
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "This does not exist yet."
generated: "docs-kb"
---

# Agent orchestration — bring your own harness (PLANNED, not built)

> **Planned** — on the roadmap, **not yet built**. Described here as intended, not as shipped.

This does not exist yet. The design: a task is a triple — goal, tier, harness preference, due-at, blocked-by, outcome — and any harness can drain the queue: Claude Code, Codex, a local Ollama script, or a human in the review queue. The graph becomes the orchestration config, so the queue outlives whichever agent CLI is fashionable this quarter, and a harness that hits a usage limit hands its task back rather than stalling it forever.

## Why it is this way

**Principle**

Portability is the product. An orchestration layer welded to one vendor's CLI dies with that CLI — and a task queue only one agent can read is a vendor lock in the middle of your knowledge graph.

**Honest Note**

Status is `planned`. Not a line of it is built. It is described here because the plan is public and reviewable, which is the point — but nobody should choose Reckons.AI today expecting this to work today.
