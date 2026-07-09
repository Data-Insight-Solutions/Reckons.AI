---
title: "Reckons.AI Graph Review — Goal & Workflow"
slug: "graph-review-story"
order: 0
section: "Testing"
parent: "test-suite"
template: doc
status: published
nav: sidebar
excerpt: "The Reckons.AI Graph Review is an offline, exhaustive audit of the whole app treated as a graph: every button is clicked, every screen is visually checked, and every finding is tied back to the graph for human review."
generated: "docs-kb"
---

# Reckons.AI Graph Review — Goal & Workflow

*Concept*

The Reckons.AI Graph Review is an offline, exhaustive audit of the whole app treated as a graph: every button is clicked, every screen is visually checked, and every finding is tied back to the graph for human review. It runs locally and Opus-reviewed — no cloud dependency — and scores against the Web/Mobile UI-UX rubric.

### The goal

Catch the failures a "click everything, flag crashes" pass misses — silent no-ops (a control that fires, throws nothing, and does nothing) and stale-cache regressions — while producing a reviewable, graph-native record rather than a throwaway log.

### Workflow overview

1. **Enumerate** — collect every interactive element on every route (buttons, tabs, leap badges, sheets).
2. **Act and assert a delta** — click each, then check that something observable actually changed (URL, node count, KB id, open panels, title, visible text). This is what catches silent no-ops.
3. **Visual check** — pixel, DOM-overlap and touch-target checks run locally; a local VLM scores each screenshot against the rubric.
4. **Persistent-context pass** — replay against a warm service worker to surface stale-cache regressions that fresh runs never reproduce.
5. **Tie to the graph** — each route becomes a TestWorkflow and each click a TestStep, carrying its screenshot, a pass/fail verdict, and a citation to any rubric guideline it violates; findings queue as pending facts for review.
6. **Review and grow** — Opus reads the coverage gaps and authors new predetermined paths, so the library grows over time.

This page is the goal and workflow overview; the stepped review itself is generated as a TestWorkflow story.
