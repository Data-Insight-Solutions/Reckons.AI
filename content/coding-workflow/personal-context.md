---
title: "Consistency comes from YOUR context, not from a better model"
slug: "personal-context"
order: 15
section: "Coding Workflow"
template: doc
status: published
nav: sidebar
excerpt: "The facts that did the work in that session were not general knowledge, and no model would have produced them from training."
generated: "docs-kb"
---

# Consistency comes from YOUR context, not from a better model

*Concept*

> **Functional** — built and working, with rough edges still being smoothed.

The facts that did the work in that session were not general knowledge, and no model would have produced them from training. 'Granularity breeds rubber-stamping — a review list that is too fine trains the human to accept all.' 'Cleaning is itself damaging; an automated tidy-up that drops a fact you needed is worse than the mess.' 'Spend attention on disagreement, not agreement.' 'Unclassified fails toward the human.' These are one person's judgments, formed on this project, written down once. Because they were in the graph, they constrained work months later — an accept-all control shipped WITH outlier highlighting rather than without it, because the graph objected.

## Details

**Example**

- The same mechanism catches the agent contradicting itself: in that session an assistant claimed a feature's status was dishonest, re-read the entity, and withdrew the claim — the graph's own record showed the status was accurate and the criticism was not. It also caught a straw-man measurement before it shipped, because a prior correction was written into the entity being cited.

**Honest Note**

- This only works for decisions that were actually WRITTEN DOWN. The graph cannot enforce a preference you never recorded, and roughly 43% of this project's commits touch the graph — that maintenance is the price, and it is not small. The case for it is that the alternative is not free either; it is just uncounted, and paid in rework.

**Principle**

- A general model gives you general answers, consistently. A graph gives you YOUR answers, consistently. The second is what a long project needs, because most of what makes a project coherent is not best practice — it is the specific, contestable calls you made and would otherwise re-litigate every few weeks.

## Related

**Part Of**

- [The saving is not compression — it is the feature you did not build twice](../coding-workflow/avoided-rework)
