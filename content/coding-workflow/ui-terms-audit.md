---
title: "Checking that the screen speaks the user's words"
slug: "ui-terms-audit"
order: 112
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "npm run offline:all includes ui-terms, which reads the text people actually see in every screen and checks it against the terminology graph."
generated: "docs-kb"
---

# Checking that the screen speaks the user's words

> **Functional** — built and working, with rough edges still being smoothed.

npm run offline:all includes ui-terms, which reads the text people actually see in every screen and checks it against the terminology graph. It flags words that describe how the product is built, such as triple or IRI, with the everyday word to use instead, and it finds 'graph' where the product means a space. A count of each may fall but never rise, so a new screen cannot add more.

<p class="derived">This is built and working.</p>

## Why it is this way

**Principle**

RULES BEFORE MODELS, AND MODELS ONLY AFTER CALIBRATION. A local model asked the same question agreed with itself every time and was right 3 times in 59. The rules are scored against those 59 hand-labelled sentences and must make no mistakes on them.

**Honest Note**

TEXT BUILT WHILE THE APP RUNS IS NOT SEEN. A space named Default Graph by the app shows 'graph' on screen, but no source line says so; a pass over rendered pages is still to come.
