---
title: "Keeping words consistent, as a standing job"
slug: "terminology-maintenance"
order: 113
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "Some words in this codebase mean several different things: graph, node, export and share."
generated: "docs-kb"
---

# Keeping words consistent, as a standing job

> **Functional** — built and working, with rough edges still being smoothed.

Some words in this codebase mean several different things: graph, node, export and share. Every day a check counts their plain, unqualified uses, and that count may fall but never rise, so new code cannot add more ambiguity without saying why. Once a week, three different local models vote on which meaning each use has, and only the uses they disagree on come back for a person. When a batch of names can be renamed safely, it arrives as a pull request to review, never as a direct change.

<p class="derived">This is built and working.</p>

## Why it is this way

**Principle**

THE COUNT CAN BE RAISED, BUT ONLY WITH A REASON WRITTEN NEXT TO IT. On its first evening the baseline was raised three times, each with the reason recorded in the terminology graph: other work had landed first, docs that quote the words while explaining them, and a page title that uses the word the screen shows.

**Honest Note**

THE WEEKLY PARTS HAVE NOT RUN YET. The daily check blocks in CI today. The weekly vote is scheduled but has not run on its own, the automatic rename pull request has never been opened (its trial run stops before that step), and the third model chosen for the vote is not installed, so another stands in.
