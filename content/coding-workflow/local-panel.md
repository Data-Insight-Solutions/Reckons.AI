---
title: "The local panel — hand many small judgments to your own GPU, get back only the doubtful ones"
slug: "local-panel"
order: 105
section: "Coding Workflow"
parent: "agent-tier"
template: doc
status: published
nav: sidebar
excerpt: "Some decisions are too fuzzy for a rule but too numerous to make one by one: which of four meanings the word 'node' has on each of 1,800 lines of code, or whether each of 500 sentences on screen should say 'space' or 'graph'."
generated: "docs-kb"
---

# The local panel — hand many small judgments to your own GPU, get back only the doubtful ones

> **Functional** — built and working, with rough edges still being smoothed.

Some decisions are too fuzzy for a rule but too numerous to make one by one: which of four meanings the word 'node' has on each of 1,800 lines of code, or whether each of 500 sentences on screen should say 'space' or 'graph'. A script gathers the evidence for each item, and a local model — running through Ollama on your own machine, costing no subscription — answers one narrow question about every item, several times. Where every answer agrees, the answer is taken. Where they disagree, the item comes back to you (or to the cloud model you are working with) with all the votes shown.

<p class="derived">This is built and working.</p>

## Why it is this way

**Principle**

AGREEMENT IS THE SIGNAL, AND IT WAS MEASURED BEFORE IT WAS TRUSTED. On 30 lines hand-checked first: when three answers agreed, they were right 29 times out of 29 across two setups. When only two of three agreed, one strong model was right 9 times in 10 and a mix of three different models only 5 in 9 — the weaker models outvoted the stronger one. So the default is one strong model answering three times, and only unanimous answers are taken without reading.

**Honest Note**

- AGREEMENT IS ONLY AS GOOD AS THE CALIBRATION FOR THAT TASK. The same afternoon, 505 sentences were put to the panel asking whether each 'graph' should read 'space'. It answered 'keep' unanimously 324 times and 'space' not once — and a spot-check found at least 137 of those unanimous answers to be sentences like 'Your graph is empty' and 'back up every graph to disk', which the product's own ruling says should say space. The model's prior that 'graph' is normal wording won three times out of three, helped by a question that offered it an easy way out. So every NEW task needs its own small hand-checked sample before its unanimous answers are trusted; none of that run's answers were applied.
- ONE CHECKER, 30 LINES, ONE WORD. The accuracy figures come from a single first calibration, not a benchmark. Letting a local model explore the code on its own (headless Claude Code pointed at Ollama) was also tried: it took two minutes, read 290,000 tokens and answered a counting question wrong. Handing the model the evidence works; asking it to go and find it does not.

## What we found

**Proof**

scripts/agent/local-panel.ts and scripts/offline/term-senses.ts, 31 tests; a hand-labelled set of 30 lines in scripts/agent/fixtures/ re-scores any change of model with --labels.

**Example**

npx tsx scripts/offline/term-senses.ts --word=node — which meaning of 'node' each line of code uses. npx tsx scripts/agent/local-panel.ts --task=task.json for any batch you build yourself: items, one question, and the shape of the answer.
