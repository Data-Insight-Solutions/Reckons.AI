---
title: "Checking your machine and dependencies, privately"
slug: "host-check"
order: 109
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "npm run host:check reads the health of the Linux machine you develop on: listening ports, mounts and similar signals."
generated: "docs-kb"
---

# Checking your machine and dependencies, privately

> **Functional** — built and working, with rough edges still being smoothed.

npm run host:check reads the health of the Linux machine you develop on: listening ports, mounts and similar signals. It only reads, never changes a setting, and never scans your network. Each check reports pass, fail, unknown or skipped, so a check it could not run is never shown as a pass. npm run security:dependencies checks every npm lockfile in the repository against the registry's advisories.

<p class="derived">This is built and working.</p>

## Why it is this way

**Principle**

WHAT YOUR MACHINE LOOKS LIKE STAYS ON YOUR MACHINE. The full report is written outside the repository, readable only by you; the terminal and any shared automation see counts only. Your own exceptions (a port you meant to open) live in a private file under ~/.config/reckons/.

**Honest Note**

LINUX ONLY, AND IT REPAIRS NOTHING. There is no macOS or Windows version, no background monitor, and no automatic fix. The dependency check shows that a vulnerable package is installed, not that your deployed app can reach it.
