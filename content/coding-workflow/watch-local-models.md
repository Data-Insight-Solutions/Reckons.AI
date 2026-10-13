---
title: "See what the local models are doing — and when they are doing nothing"
slug: "watch-local-models"
order: 106
section: "Coding Workflow"
parent: "agent-tier"
template: doc
status: published
nav: sidebar
excerpt: "A local run is an ordinary command, not an agent your coding tool knows about, so it never appears in its list of running agents."
generated: "docs-kb"
---

# See what the local models are doing — and when they are doing nothing

> **Functional** — built and working, with rough edges still being smoothed.

A local run is an ordinary command, not an agent your coding tool knows about, so it never appears in its list of running agents. npm run agent:watch is the window instead: whether Ollama is up and which model is loaded into the graphics card's memory, how busy the cards are, every request any program made to a local model today, and for each panel run its progress, how many items the answers disagree on so far, and the latest answers with their reasons. A one-line version fits a status bar.

<p class="derived">This is built and working.</p>

## Why it is this way

**Principle**

SILENCE IS REPORTED AS SILENCE. The window exists because a whole morning of work once used no local model at all and nothing on screen could say so. 'None today — no local model has been asked anything' is a line it prints, not a blank.

**Honest Note**

Reading Ollama's request log needs journalctl, so on a machine where Ollama is not a systemd service the window says the log is unreadable and shows only panel runs. The run log lives outside the repository, under ~/.local/state/reckons/, because answers quote source lines.

## What we found

**Proof**

scripts/agent/watch.ts and scripts/agent/local-activity.ts, 16 tests. Its first reading showed 217 local requests that day, every one after the question was raised.

**Example**

npm run agent:watch (live) · npm run agent:watch -- --once (one snapshot) · npm run agent:watch -- --statusline (one line, cached so it returns in a quarter of a second).
