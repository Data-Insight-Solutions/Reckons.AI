---
title: "Software engineering"
slug: "software-engineering"
order: 1018
section: "Use Cases"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI is built with Reckons.AI, and that is the honest reason this use case is the most detailed one here: it is the only one we have run for a year."
generated: "docs-kb"
related:
  - "what-is-reckons-ai"
---

# Software engineering

Reckons.AI is built with Reckons.AI, and that is the honest reason this use case is the most detailed one here: it is the only one we have run for a year. A codebase accumulates decisions faster than anything else you own — why a boundary exists, what a change would break, which claim a test actually pins — and almost none of it survives in the code. It ends up in commit messages nobody re-reads, in chat histories that expire, and in the heads of whoever was there. The graph is where those decisions are kept as facts you can query, and the pages you are reading are generated from it.

## At a glance

**Audience**

Anyone maintaining a codebase with more history than any one person remembers — and anyone whose coding agents keep asking questions the last session already answered.

## Why it is this way

**Principle**

The plan lives in the graph, not in the code. A feature exists as an entity with a status before it exists as a file, and the status ladder is honest — speculative, planned, scaffolded, functional, production. A feature is not functional because we wish it were. That single rule is what makes the graph usable as a plan rather than as marketing: you can ask what is actually built and get an answer that has been kept true.

**Honest Note**

The gaps are in here too, which is the point of writing them down. On 2026-09-08 a check found that 62% of the generated documentation pages were under 120 words — a title and a paragraph — because thin concepts with no parent cannot be folded into anything. That finding is a fact in this graph, it is why this page is written as a parent with folded children, and you are reading the fix.

## What we found

**Measured**

DOGFOODED AT A REAL SIZE, as of 2026-09-08: seven graphs describing the product, roughly 16,300 facts, with the codebase graph carrying a file link for every git-tracked source file. Six alignment gates run on every change and fail the build when the published site stops saying what the graph says.

## In this section

### Coding agents that start already knowing

An agent queries the same graph over MCP instead of re-reading the repository, so the conventions it follows are the ones written down rather than the ones it inferred.

### Decisions that keep their evidence

A benchmark result stays attached to the decision it justified, so next year the question is what the number was, not what someone remembers concluding.

### Documentation that cannot quietly go stale

Pages are generated from the graph, so a page cannot disagree with the facts it was made from without a gate failing. Change the graph and the page follows; hand-edit the page and the build tells you.

### The codebase, as facts

Modules, files and their dependencies become entities, so what a change touches is a query rather than a guess. The graph holds the part the source cannot: why the boundary is there.

**[Why a graph, and not a notepad](../use-cases/why-not-a-notepad)**

Take one sentence from a real working note: Vantage Suite was dropped at this stage on file format grounds.

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
