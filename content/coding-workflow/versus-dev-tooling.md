---
title: "Compared with the tools you already use"
slug: "versus-dev-tooling"
order: 99
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "A developer keeping track of a codebase today typically runs three or four separate things: a coding agent that reads the repository, something that maps or searches the code, something that remembers across sessions, and a documentation site."
generated: "docs-kb"
related:
  - "git-analysis-coding-workflow"
---

# Compared with the tools you already use

A developer keeping track of a codebase today typically runs three or four separate things: a coding agent that reads the repository, something that maps or searches the code, something that remembers across sessions, and a documentation site. Each is good at its job. The claim here is not that Reckons.AI beats any of them at that job — it does not — but that the four are the same store viewed four ways, and keeping them separate is what makes each of them lose the others' work.

## At a glance

**Audience**

Anyone already running Claude Code, a codebase search tool, an agent memory plugin, or a docs site — and wondering what a graph adds that those do not.

## Why it is this way

**Principle**

THE CLAIM IS ONE STORE, FOUR VIEWS — and this project is the test case rather than the advertisement. The same graph is the PLAN (a feature is an entity with a status before it is a file), the AGENT'S CONTEXT (queried over MCP by 18 tools rather than re-read), and the PUBLISHED SITE (these pages are generated from it). A decision recorded once shows up in all three. Nothing is copied between them, so nothing can disagree.

**Honest Note**

- AND THE COSTS, WHICH ARE REAL. Every specialist tool above is better at its own job, and a graph is a slower way to get their answer. The store has to be MAINTAINED — extraction recovers 53-63% of expected facts on a median run, so the rest is human work, and a graph nobody tends is worse than no graph because it looks authoritative. Claude Code with a CLAUDE.md is free, works today, and is the right answer for most repositories. This approach earns its keep when the knowledge outlives the session, the decisions have to be justified later, and several audiences — a person, an agent, a reader — need the same answer.
- DEPTH OF THIS COMPARISON: the tool categories above are drawn from READMEs read on 2026-09-08, not from running each product. The Claude Code figure is measured in this repository; the rest is a fair reading of what those tools say they do. Treat the category descriptions as accurate and the head-to-head as unmeasured, because it is.

## What we found

**Measured**

WHAT THAT LOOKS LIKE IN PRACTICE HERE, as of 2026-09-08: seven graphs describing the product, roughly 16,300 facts, a codebase graph with a file link for every git-tracked source file, and six alignment gates that fail the build when the published site stops saying what the graph says. The gates are the part that makes the claim checkable rather than aspirational — a documentation site that cannot disagree with the plan is a different thing from one that happens to agree today.

**Example**

- A CODING AGENT reads the repository each session and its context dies with the session. CLAUDE.md is usually the only persistence, and it is a flat file re-read in full every time. This project measured what that costs on its own handoff notes: 45.0 MILLION carried tokens across fourteen reads, the single most expensive artifact in the repository, which is why the old sessions were split into an archive. A file is a fine place to keep instructions and a bad place to keep knowledge, because you cannot query part of it.
- A DOCUMENTATION SITE publishes pages a person reads, and has no idea which fact any page rests on. Change something true and no page moves; change a page and nothing tells the graph. That is the correspondence problem, and it is the one nobody in this list holds.
- AGENT MEMORY TOOLS persist concepts across sessions, which is the right instinct and closes the worst gap above. The limit is who the memory is FOR: it is the agent's recollection, in the agent's store, and nobody reads it as a document. When a person needs the same knowledge they get it by asking the agent, which is a strictly worse interface than a page.
- CODE GRAPHING TOOLS map what the code IS — call graphs, blast radius, which tests to run. They are genuinely good at it, faster and more precise than anything here, and they are reading the source. What the source cannot tell them is WHY a boundary exists, what was tried and rejected, or which claim a decision rested on. That is not a gap in those tools; it is absent from the input they read.

## Related

- [Check your work against the plan (git analysis)](../coding-workflow/git-analysis-coding-workflow)
