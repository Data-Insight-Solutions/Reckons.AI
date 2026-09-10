---
title: "Coding workflow"
slug: "coding-workflow"
order: 90
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI turns a codebase into a graph you can interrogate, and then keeps the code and the plan honest with each other."
generated: "docs-kb"
---

# Coding workflow

Reckons.AI turns a codebase into a graph you can interrogate, and then keeps the code and the plan honest with each other. The plan lives in the graph; code is checked against it; agents propose, humans decide. This page is generated from that same graph, so it cannot claim a capability the graph does not have.

<p class="derived">It has 11 parts below, 3 of which are not built yet.</p>

## Why it is this way

**Principle**

- Agents propose; humans dispose. Every automated finding lands as a PENDING fact for review, never as a silent edit to source or to the graph.
- Route work to the cheapest tier that can do it correctly. Most of what an AI coding assistant is asked to do is not judgment — it is a rule, and a rule should be a script.
- The graph is the plan. A feature must exist in the roadmap graph before it is built, and its status must reflect reality — not what we wish were true.

## Steps

<div class="card-grid">

<a class="card" href="../coding-workflow/repo-ingest"><span class="card-title">Ingest a repository into a graph</span><span class="card-text">Point Reckons.AI at a repository and it builds a Codebase graph: modules, their source files (kpred:has-file), and the relationships between them.</span></a>
<a class="card" href="../coding-workflow/git-analysis-coding-workflow"><span class="card-title">Check your work against the plan (git analysis)</span><span class="card-text">The graph knows what you INTENDED.</span></a>
<a class="card" href="../coding-workflow/ci-cd-graph-watch"><span class="card-title">CI/CD graph watch — the plan reviews your PR</span><span class="card-text">On every push and pull request, CI compares the code changes against the plan in the graph and posts an alignment report as a PR comment: score, discrepancies, drift warnings, and a KB snapshot artifact.</span></a>
<a class="card" href="../coding-workflow/work-tiering"><span class="card-title">Work tiering — stop paying frontier prices for rules</span><span class="card-status">in-progress</span><span class="card-text">Every recurring task is routed to the cheapest tier that can do it correctly.</span></a>
<a class="card" href="../coding-workflow/agents-ask-the-graph"><span class="card-title">Agents ask the graph, not you</span><span class="card-text">When an agent needs a decision it cannot make, it does not stop and wait for you.</span></a>
<a class="card" href="../coding-workflow/rolling-digest"><span class="card-title">One report that grows, instead of twenty that interrupt</span><span class="card-text">Agents append findings — bug found, claim falsified, shipped, decision needed — to a single dated digest while you are away, and each finding is also written into the graph as a pending fact on the entity it concerns.</span></a>
<a class="card" href="../coding-workflow/versus-dev-tooling"><span class="card-title">Compared with the tools you already use</span><span class="card-text">A developer keeping track of a codebase today typically runs three or four separate things: a coding agent that reads the repository, something that maps or searches the code, something that remembers across sessions, and a documentation site.</span></a>
<a class="card" href="../coding-workflow/context-compression-coding-workflow"><span class="card-title">Feed an agent the graph, not the repo</span><span class="card-text">kb_compress selects the relevant subgraph for a question and serializes it compactly, so an agent gets grounded context instead of a directory listing.</span></a>
<a class="card" href="../coding-workflow/agent-orchestration"><span class="card-title">Agent orchestration — bring your own harness (PLANNED, not built)</span><span class="card-status">planned</span><span class="card-text">This does not exist yet.</span></a>
<a class="card" href="../coding-workflow/scheduling"><span class="card-title">Task scheduling in the graph (PLANNED, not built)</span><span class="card-status">planned</span><span class="card-text">This does not exist yet.</span></a>
<a class="card" href="../coding-workflow/avoided-rework"><span class="card-title">The saving is not compression — it is the feature you did not build twice</span><span class="card-text">The usual pitch for a knowledge graph in front of a coding agent is token compression: feed a dense subgraph instead of re-reading the repo.</span></a>

</div>
