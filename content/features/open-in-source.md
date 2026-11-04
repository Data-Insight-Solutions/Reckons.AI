---
title: "Open a fact's source at the exact words"
slug: "open-in-source"
order: 1027
section: "Features"
parent: "passage-grounding"
template: doc
status: published
nav: sidebar
excerpt: "When Reckons.AI reads a source and proposes a fact, the fact records exactly which stretch of text it came from: the passage, where the quote starts and ends, and a fingerprint of the source's text at that moment."
generated: "docs-kb"
---

# Open a fact's source at the exact words

> **Functional** — built and working, with rough edges still being smoothed.

When Reckons.AI reads a source and proposes a fact, the fact records exactly which stretch of text it came from: the passage, where the quote starts and ends, and a fingerprint of the source's text at that moment. Open a fact's Evidence and press Open in source: the source opens, scrolls to the passage, and the quoted words are marked. If the quote cannot be found in the text that was kept, there is no button, and the Evidence section says why. If the source's text has changed since the fact was taken from it, the evidence is marked stale, either because the source changed or because the passage moved. A stale link is never quietly pointed at different words.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

TEXT ONLY. A fact can point at a passage of text, not at a page of a PDF, a box on a page or a region of an image. Those kinds of anchor are planned and not built.
