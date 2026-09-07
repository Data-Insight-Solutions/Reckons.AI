---
title: "Coding workflow"
slug: "coding-workflow"
order: 1
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI turns a codebase into a graph you can interrogate, and then keeps the code and the plan honest with each other."
generated: "docs-kb"
---

# Coding workflow

Reckons.AI turns a codebase into a graph you can interrogate, and then keeps the code and the plan honest with each other. The plan lives in the graph; code is checked against it; agents propose, humans decide. This page is generated from that same graph, so it cannot claim a capability the graph does not have.

## Why it is this way

**Principle**

- Agents propose; humans dispose. Every automated finding lands as a PENDING fact for review, never as a silent edit to source or to the graph.
- Route work to the cheapest tier that can do it correctly. Most of what an AI coding assistant is asked to do is not judgment — it is a rule, and a rule should be a script.
- The graph is the plan. A feature must exist in the roadmap graph before it is built, and its status must reflect reality — not what we wish were true.

## Steps

**[Ingest a repository into a graph](../coding-workflow/repo-ingest)**

Point Reckons.AI at a repository and it builds a Codebase graph: modules, their source files (kpred:has-file), and the relationships between them.

**[Check your work against the plan (git analysis)](../coding-workflow/git-analysis-coding-workflow)**

The graph knows what you INTENDED.

**[CI/CD graph watch — the plan reviews your PR](../coding-workflow/ci-cd-graph-watch)**

On every push and pull request, CI compares the code changes against the plan in the graph and posts an alignment report as a PR comment: score, discrepancies, drift warnings, and a KB snapshot artifact.

**[Work tiering — stop paying frontier prices for rules](../coding-workflow/work-tiering)** — **in-progress**

Every recurring task is routed to the cheapest tier that can do it correctly.

**[Agents ask the graph, not you](../coding-workflow/agents-ask-the-graph)**

When an agent needs a decision it cannot make, it does not stop and wait for you.

**[One report that grows, instead of twenty that interrupt](../coding-workflow/rolling-digest)**

Agents append findings — bug found, claim falsified, shipped, decision needed — to a single dated digest while you are away, and each finding is also written into the graph as a pending fact on the entity it concerns.

**[Feed an agent the graph, not the repo](../coding-workflow/context-compression-coding-workflow)**

kb_compress selects the relevant subgraph for a question and serializes it compactly, so an agent gets grounded context instead of a directory listing.

**[Agent orchestration — bring your own harness (PLANNED, not built)](../coding-workflow/agent-orchestration)** — **planned**

THIS DOES NOT EXIST YET.

**[Task scheduling in the graph (PLANNED, not built)](../coding-workflow/scheduling)** — **planned**

THIS DOES NOT EXIST YET.

**[The saving is not compression — it is the feature you did not build twice](../coding-workflow/avoided-rework)**

The usual pitch for a knowledge graph in front of a coding agent is token compression: feed a dense subgraph instead of re-reading the repo.
