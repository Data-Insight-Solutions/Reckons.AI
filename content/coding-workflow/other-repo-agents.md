---
title: "The same deputies, working in another repository"
slug: "other-repo-agents"
order: 120
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "The deputy is not locked to this repository."
generated: "docs-kb"
---

# The same deputies, working in another repository

> **Functional** — built and working, with rough edges still being smoothed.

The deputy is not locked to this repository. It can be started inside a different repository — one with its own instruction file and its own tool connections — and it works there under the same rules: no configured cloud login, denied push and merge commands, and an agent branch. These are permission limits, not a sandbox: the deputy still runs as the same operating-system user. The tool that answers questions about a repository's graph can be pointed at a different repository's set of knowledge, and it answers only from there. And a recurring scheduled job can name the folder it should work in. One deliberate gap stays human: a new repository's tool connections are loaded only after a person, once, has run the deputy there and accepted the trust prompt. That step is not an oversight — skipping it is exactly what the safety review refused to allow.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

FUNCTIONAL, WITH ONE HUMAN STEP. The live check ran against a second real repository: the deputy reported that folder as its working directory, quoted that repository's instruction file, and its push was still refused. What was verified was the refusal and the keeping-apart of the two repositories' review queues, not the quality of the work done inside the other repository.
