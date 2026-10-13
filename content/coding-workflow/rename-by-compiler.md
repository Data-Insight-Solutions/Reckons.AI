---
title: "Renaming by compiler — every reference, or no rename at all"
slug: "rename-by-compiler"
order: 108
section: "Coding Workflow"
parent: "taxonomy-management"
template: doc
status: published
nav: sidebar
excerpt: "Search-and-replace renames the wrong things (the word inside an error message) and misses the right ones (a reference in another file)."
generated: "docs-kb"
---

# Renaming by compiler — every reference, or no rename at all

> **Functional** — built and working, with rough edges still being smoothed.

Search-and-replace renames the wrong things (the word inside an error message) and misses the right ones (a reference in another file). scripts/offline/rename-identifier.ts asks the TypeScript compiler for every reference to a name and changes exactly those, or refuses and says why. No model edits the code.

<p class="derived">This is built and working.</p>

## Why it is this way

**Principle**

IT REFUSES WHERE A RENAME WOULD COMPILE AND STILL BE WRONG. Removing the underscore from _prompt inside a function that already has a parameter called prompt turns an assignment into 'prompt = prompt' — valid code that silently stops working. The tool asks the compiler, at every reference, whether another thing with the new name is already visible there, and refuses if so. It also refuses a reserved word, a name already taken, and any exported name while some import in the project cannot be resolved, because an importer it cannot see is one it would silently skip.

**Honest Note**

A name exported and used inside a .svelte file is refused until Svelte support is added, because the compiler it asks cannot see inside those files.

## What we found

**Proof**

scripts/offline/rename-identifier.ts, 19 tests including both kinds of refusal. Batch 1 renamed 65 names in 5.5 seconds and refused 9 that would have been captured this way.

**Example**

npx tsx scripts/offline/rename-identifier.ts --rename=src/lib/x.ts:oldName:newName --dry-run · --interface-to-type=&lt;file&gt;:&lt;Name&gt; · --batch=underscore-module-state
