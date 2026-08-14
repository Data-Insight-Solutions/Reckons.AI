---
title: "Task scheduling in the graph (PLANNED, not built)"
slug: "scheduling"
order: 12
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "THIS DOES NOT EXIST YET."
generated: "docs-kb"
---

# Task scheduling in the graph (PLANNED, not built)

*Concept*

> **Planned** — on the roadmap, **not yet built**. Described here as intended, not as shipped.

THIS DOES NOT EXIST YET. Tasks, schedules and outcomes as graph facts, drained by whichever runner is available — the in-app worker on any device, an optional desktop process, or the MCP server when an agent is already connected.

## Details

**Honest Note**

- Status is `planned`. We have already been burned once by the opposite: a cloud cron fired exactly on schedule, produced nothing, reported nothing, and still displayed a future run time — it LOOKED armed while being dead. That failure is why this is designed around an observable queue rather than a timer.

**Principle**

- A scheduler you cannot observe is not a scheduler, it is a rumour. Every run must write its outcome back — including 'I did nothing, and here is why'.

## Related

**Part Of**

- [Coding workflow](../coding-workflow/coding-workflow)
