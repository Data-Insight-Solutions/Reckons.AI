---
title: "Git Analysis"
slug: "git-analysis-features"
order: 1011
section: "Features"
parent: "mcp-workspace"
template: doc
status: published
nav: sidebar
excerpt: "Git-aware MCP tools for agent plan alignment."
generated: "docs-kb"
---

# Git Analysis

*Feature*

> **Functional** — built and working, with rough edges still being smoothed.

Git-aware MCP tools for agent plan alignment. Tools: kb_git_status (branch/commits), kb_check_plan (BM25 drift detection), kb_pending (review queue), kb_git_diff_triples (file-to-Graph cross-ref), kb_alignment_score (quantitative 0-1 score across 4 dimensions: coverage, status alignment, dependency respect, scope discipline). Enhanced kb_add_note supports type, priority, agent, and commit_sha metadata.

## Details

**Honest Note**

- No automated test covers this (audited 2026-07-12). Shipped and in use; the coverage gap is declared rather than hidden (kb:honest-status). NOTE: this entity duplicates kb:git-analysis in the roadmap under a different IRI — same feature, split identity.

**Test Coverage**

- none
