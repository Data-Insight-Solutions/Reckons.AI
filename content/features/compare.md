---
title: "Compare — finding out where two people actually disagree"
slug: "compare"
order: 1008
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Put two graphs side by side and see what is new, what agrees, and what conflicts."
generated: "docs-kb"
related:
  - "review-system"
---

# Compare — finding out where two people actually disagree

> **Production** — built, tested, and in use.

Put two graphs side by side and see what is new, what agrees, and what conflicts. Two colleagues who have each read around the same subject can find the three things they disagree about in a minute, instead of discovering them in a meeting six weeks later.

<p class="derived">This is built, working, and in daily use here. It has 2 parts below, 1 of which is not built yet.</p>

<p class="in-sets">Part of Ask it things.</p>

THE COMPARE HAS ONE HOME NOW: THE REVIEW TAB. Opening a compare from the Review tab, from the old /compare address, or from the Add page, all lands in the same view. When you add a new piece of knowledge, the button on the Add page takes you to that same view and says what it will do — Extract statements — and every label and button on the compare says statements, the word people use, not facts. When the small model that spots near-misses is already on your device, the differences carry richer labels — new, repeat, near-duplicate, contradiction — alongside the plain structural ones. If it is not on the device, you get the plain labels alone, and the view is still complete: it just cannot tell you that two sentences are near duplicates.

## At a glance

**Audience**

Anyone who has to reconcile what they know with what somebody else knows.

## Why it is this way

**Principle**

- AND A STANDARD VOCABULARY IS WHAT MAKES IT FAST. Writing skos:broader instead of inventing your own word for is-part-of is dull and slightly awkward by hand — and it is why a stranger's graph lines up with yours without a mapping exercise. The tedious part of interoperability is the part you are doing when you pick a standard term.
- THIS IS WHAT CLEAR CLAIMS BUY YOU, and it is the return on the review work that is hardest to see up front. Two piles of notes cannot be compared at all — you would have to read both. Two graphs can, but only where they say things in the same shape and the same words. Every time you confirm a fact rather than leaving a paragraph, you are making your knowledge comparable to somebody else's.
- YOU COMPARE CLAIMS, NOT SOURCES. My graph learned something from my file and yours learned it from yours; that is not a disagreement about anything, and a diff that reports it is wasting your attention. What two graphs can genuinely disagree about is what they believe — which is why the relation layers separate a claim about the world from a record of where it came from.

**Constraint**

IT CAN ONLY COMPARE WHAT WAS WRITTEN DOWN. Two graphs that use different words for the same relation will show as disagreeing when they agree, and the fix is the same vocabulary work as everywhere else here — there is no clever matching that removes it.

**Honest Note**

TWO HONEST NOTES. The four richer labels were tested with a model that gives fixed, repeatable answers, not with the small model that would run on a real device: the machinery is proven, the real model's exact judgment is not yet measured. And the view that draws the incoming statements over your own canvas (new ones as amber ghosts, repeats folded onto the statement they repeat, each contradiction as a red-ringed ghost with a card naming where each side came from) is built but still marked in progress. It works on the flat 2D canvas only, and its test checks the counts and cards, not the drawn pixels.

## Detail

**Alt Label**

Compare / Diff Engine

## In this section

**[Compare two documents side by side as a Venn diagram](../features/compare-two-documents)** — **scaffolded**

Put two documents next to each other and see what they have in common and where they differ.

### Diff Summary

LLM-generated 3-part summaries of diffs: what is new, what reinforces existing knowledge, and what conflicts. Integrated in /compare, /review, and the browser extension sidepanel.

## Related

- [Compare — finding out where two people actually disagree](../features/compare)
- [Review — where your graph gets smaller and truer](../features/review-system)
