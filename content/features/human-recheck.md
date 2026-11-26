---
title: "A person's check has a date, and goes stale"
slug: "human-recheck"
order: 1003
section: "Features"
parent: "agent-trust-checks"
template: doc
status: published
nav: sidebar
excerpt: "Some things no automated test can see, such as whether a voice sounds right or a story reads well on a real phone."
generated: "docs-kb"
---

# A person's check has a date, and goes stale

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

Some things no automated test can see, such as whether a voice sounds right or a story reads well on a real phone. A person looks, and says so. But that look covers only the code that ran at the time. This feature makes the look a dated record instead of a permanent approval. Two notes can be put on any item in the project's own plan: one records a check (a date, what was checked and by whom); the other asks for one (a date, what a person must look at, and why no test covers it). A script reads all of them and lists each item as OPEN (asked for and not yet checked), STALE (checked, but a file it depends on has changed since), or CURRENT. It compares dates with the version history, so a STALE line is a reason to look again, not proof that anything broke. The first requests were recorded on the Kokoro voice and on the Data Insight Solutions story in 3D on a real phone.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

SCAFFOLDED, AS OF 2026-11-25. The script is built and has 7 unit tests, but it is not yet part of the standing group of checks that run with every change, and its list is not yet shown on the release review page, so for now it only prints a list when someone runs it. It is a prompt for a person, not a gate.
