---
title: "Treating every input as untrusted"
slug: "untrusted-input"
order: 110
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "Anything that arrives from outside can carry an attack: page titles, markdown, themes, model replies, archive contents, command-line arguments."
generated: "docs-kb"
---

# Treating every input as untrusted

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

Anything that arrives from outside can carry an attack: page titles, markdown, themes, model replies, archive contents, command-line arguments. The plan is for the site publisher, the browser extension, the QR code flow and the CLI to treat all of it as untrusted. Output is escaped or sanitized, file paths are kept inside a safe folder, and commands are run with their arguments passed separately rather than built as one string.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

PARTLY DONE. Template arguments are now quoted for the shell rather than as JSON (a real injection, fixed in v0.2.5). The sanitizer allowlist for generated sites, path and cleanup limits, and pinned CMS code are not all in place yet, so treat a site generated from an untrusted graph with care.
