---
title: "Detail levels: show the main entities first, the evidence last"
slug: "detail-levels"
order: 1016
section: "Features"
parent: "graph3-d"
template: doc
status: published
nav: sidebar
excerpt: "A large collection draws too many entities to read."
generated: "docs-kb"
---

# Detail levels: show the main entities first, the evidence last

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

A large collection draws too many entities to read. The detail control lets you start with the few that matter, such as the hubs and the decisions, and step down toward the finer judgments and evidence. For that to work every entity needs a level. Each entity now gets one: by default, the highest level among the facts that mention it, and a person or a collection can override it by setting a detail-level value on the entity itself. Two things were also fixed. The nine kinds of bookkeeping the review process stores (such as a fact's status, its confidence and its review notes) no longer count as content when levels are worked out; they are records. And evidence now has a meaning that can be computed: a fact is evidence when it has been reviewed and it supports a claim. Pending facts do not count.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

SCAFFOLDED, NOT FINISHED, AS OF 2026-11-24. The goal was that each step of the control draws a different, non-empty group of entities on every example collection. That is not met: on all four example collections the evidence step draws the same entities as the judgments step, and on two of them the decisions step draws none. The browser test therefore reports how many entities each step draws on the Quick-Start example (48 for all, 18 for detailed, 11 for evidence, 11 for judgments, 6 for decisions, 2 for hubs) instead of asserting that they differ. Your own collections will mostly still show most facts as judgments until more of their predicates are classified.
