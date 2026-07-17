---
title: "Check your work against the plan (git analysis)"
slug: "git-analysis-coding-workflow"
order: 3
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "The graph knows what you INTENDED."
generated: "docs-kb"
---

# Check your work against the plan (git analysis)

*Concept*

> **Production** — built, tested, and in use.

The graph knows what you INTENDED. Git knows what you DID. Git analysis compares them: kb_check_plan tells you whether the work you are about to do matches something planned; kb_git_diff_triples finds which graph entities your diff actually touched; kb_alignment_score gives a 0-1 score across four dimensions (coverage, status alignment, dependency respect, scope discipline). Commits that match no planned work are flagged as unplanned — not blocked, but not invisible either.

## Details

**Proof**

- Exposed as MCP tools, so any MCP-speaking agent can use them. Runs in CI (kb-watch.yml).

## Related

**Part Of**

- [Coding workflow](../coding-workflow/coding-workflow)
