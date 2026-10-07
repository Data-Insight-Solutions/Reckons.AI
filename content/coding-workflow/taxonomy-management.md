---
title: "Repository taxonomy — one word per meaning, in the code and on the screen"
slug: "taxonomy-management"
order: 107
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "A codebase drifts into using one word for several things and several words for one thing."
generated: "docs-kb"
---

# Repository taxonomy — one word per meaning, in the code and on the screen

> **In progress** — actively being built. Parts of what follows may not work yet.

A codebase drifts into using one word for several things and several words for one thing. Here 'graph' meant four different things and 'node' five. The taxonomy is a graph of terms (static/reckons-terminology.ttl): each meaning gets its own entry, with the word a user sees, the word a developer uses, the standards term underneath, and how costly the word is to change. Scripts then measure how every term is used, local models judge the doubtful cases, and a compiler-driven tool renames code in batches, with checks that stop a batch from making things worse.

<p class="derived">This is being built now. It has one part below.</p>

## Why it is this way

**Principle**

- ON SCREEN, THE PERSON'S WORD WINS. One knowledge base is a 'space' to its user; 'knowledge base' is the developer's word and 'RDF dataset' the standard's. scripts/offline/ui-copy.ts reads every template with Svelte's own compiler, so only text a person actually sees or hears is counted, and rewrites the retired abbreviation KB by rule.
- THREE KINDS OF NAME, THREE COSTS. A FREE name (a local variable) can be renamed and costs a diff. A CONTRACT name (a storage key, an address saved in someone's data, a tool name other programs call) needs a data migration and is left alone by the rename. A FOREIGN name (belonging to RDF, three.js or the browser) is never renamed; it is qualified instead.

**Honest Note**

IN PROGRESS. Two rename batches are done (5 constants, 3 type declarations, 65 module-level names). 20 names were refused and wait for decisions. Renames cannot yet reach inside .svelte files, and there is no pixel-for-pixel visual check yet, so a rename is checked by the type checker, the unit tests and the browser tests only.

## What we found

**Example**

npm run offline:terms (how each term is used) · npx tsx scripts/offline/ui-copy.ts (what a user reads) · npx tsx scripts/offline/naming-conventions.ts --check (the ratchet: a decided rule may not get worse).

## Steps

**[Renaming by compiler — every reference, or no rename at all](../coding-workflow/rename-by-compiler)**

Search-and-replace renames the wrong things (the word inside an error message) and misses the right ones (a reference in another file).
