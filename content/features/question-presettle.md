---
title: "Open questions answered from what you already decided"
slug: "question-presettle"
order: 1028
section: "Features"
parent: "review-system"
template: doc
status: published
nav: sidebar
excerpt: "An open question in the review queue — one with no proposed answer — can only be rejected or put off, so it waits."
generated: "docs-kb"
---

# Open questions answered from what you already decided

> **Functional** — built and working, with rough edges still being smoothed.

An open question in the review queue — one with no proposed answer — can only be rejected or put off, so it waits. Before it does, a job tries to answer it from your own knowledge base. First a rule: when the question is about a file that may have been deleted, the job requires evidence of its deletion in dev history before offering an answer saying the question no longer applies. Absence from one checkout alone is not enough. Then a model running on your machine, with no call to the cloud, may answer, but it may only quote a decision you already recorded, and a second model on your machine checks the quote is really there before the answer is offered. An answer arrives as a proposal attached to the question's own decision: accepting it settles the question in one act, and the job itself settles nothing — it writes proposals, never decisions. In the run recorded on 2026-10-29 (UTC), 232 open questions yielded three candidate answers after the checks; human review found two usable, and only those two were queued. The checks also refused eleven model answers. The job did not settle any decision itself. It is a tool you run before asking, not a recurring job: at that yield, the queue mostly asks for an action, not a fact.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

MOST OF THE QUEUE IS NOT ANSWERABLE THIS WAY. The questions the run left open are mostly machine findings that want an action, and the rest are genuinely open. The checking model was calibrated on two cases, and its precision on that one run was 2 of 3. An inline answer box on the review page is a later part of the same plan, and is not this job.
