---
title: "Agents ask the graph, not you"
slug: "agents-ask-the-graph"
order: 97
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "When an agent needs a decision it cannot make, it does not stop and wait for you."
generated: "docs-kb"
---

# Agents ask the graph, not you

> **Functional** — built and working, with rough edges still being smoothed.

When an agent needs a decision it cannot make, it does not stop and wait for you. It emits the question AS A PARTIAL FACT into the graph — subject and predicate known, object '?', plus a note on what the question blocks — and moves to the next unblocked task. You answer whenever you like, in the review queue. The answer flows back and the waiting work resumes.

## Why it is this way

**Principle**

- A question asked in a chat window is gone when the session ends. A question left as a partial fact is dated, reviewable, searchable, and attached to the thing it is about.
- The user is the bottleneck. Do not make them a blocking call.

## What we found

**Proof**

scripts/agent/ask.ts + answers.ts, 15 tests.
