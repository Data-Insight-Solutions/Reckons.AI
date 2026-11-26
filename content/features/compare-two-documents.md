---
title: "Compare two documents side by side as a Venn diagram"
slug: "compare-two-documents"
order: 1009
section: "Features"
parent: "compare"
template: doc
status: published
nav: sidebar
excerpt: "Put two documents next to each other and see what they have in common and where they differ."
generated: "docs-kb"
---

# Compare two documents side by side as a Venn diagram

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

Put two documents next to each other and see what they have in common and where they differ. FEEDING IT: on the Ingest page, the compare-two tab (an entry on a page you already use, not a new tab in the main navigation) takes a name for the comparison and, for each side, a web address or a file (a PDF or plain text). Each side is read in turn by the same ingest you already use: the original is kept, the claims are pulled out, and they are checked against the facts already held. The pair is recorded as one named comparison, and every claim keeps the document it came from. While it runs, each side shows its stage and the seconds elapsed. If one side fails or is refused, it is shown as failed with the reason, and the comparison still opens with the side that arrived. When it finishes, you get a direct link of the form /?layout=compare&a=&lt;first&gt;&b=&lt;second&gt;. SEEING IT: that link draws the comparison on the main canvas as a Venn diagram, not on a separate screen. Claims only the first document makes sit in one lobe, in blue; claims only the second makes sit in the other, in red; claims both make sit in the overlap, in purple. Two claims count as shared when they mean nearly the same thing, even in different words, not only when the text is identical. The three colors are defaults you can change and revert. The panel shows a legend and a count for each color. The layout only reads the facts; turning it off leaves them exactly as it was. If fewer than two documents exist yet, the panel says what it needs.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

EARLY (SCAFFOLDED), AS OF 2026-11-26. Ingesting two documents was exercised only with a pretend reader (about 2 seconds for a whole run on that); it has not been measured with a real model, nor with a real PDF, which needs a Mistral key, and a side without one fails with the Document tab's message. Nobody has timed it against the five-minute bound on a real machine. The Venn layout passes its unit and browser tests on made-up data, but it has not yet been checked on a copy of real data. Whether a color choice applies everywhere or only here is not settled.
