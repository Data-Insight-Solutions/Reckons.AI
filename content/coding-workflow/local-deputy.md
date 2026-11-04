---
title: "The local deputy — the same assistant, on your own machine"
slug: "local-deputy"
order: 117
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "When the subscription to the cloud model runs out of usage, work does not have to stop."
generated: "docs-kb"
---

# The local deputy — the same assistant, on your own machine

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

When the subscription to the cloud model runs out of usage, work does not have to stop. A command starts the same coding assistant — same instructions, same tools, same access to this repository's knowledge base — against a model running on this machine instead of in the cloud: the local model server (Ollama) speaks the same interface the assistant expects, while the model, credentials and permissions differ from the cloud session. A separate settings folder holds no cloud login, and every model name the assistant would otherwise use, including the sub-sessions it can spawn, is mapped to the local model, so normal launcher requests are directed to Ollama. This is configuration and permission enforcement, not a sandbox. You talk to it the way you talk to the cloud model, and what it decides is written down as proposals — a note in the review queue and a branch of work — for the next cloud session to review. It is a deputy: it proposes, it never merges.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

SCAFFOLDED, AND NOT A SANDBOX. What stops it pushing, opening pull requests or merging is withheld credentials and deny rules, not an isolated environment: it runs as the same user, and a determined model could read that user's files. A real boundary — a separate user or a container — is not built. A guard also refuses a local model whose context window is too small to hold the assistant's instructions, because silently truncated instructions are worse than none.
