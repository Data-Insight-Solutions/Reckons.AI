---
title: "How often each overseer stops, measured"
slug: "overseer-bench-rates"
order: 119
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "An overseer is the agent that decides, over other agents' work, whether to proceed or to stop."
generated: "docs-kb"
---

# How often each overseer stops, measured

> **Functional** — built and working, with rough edges still being smoothed.

An overseer is the agent that decides, over other agents' work, whether to proceed or to stop. A bench replays a fixed set of scenarios — a CI failure to triage, a diff to review, a malformed queue — many times on each model, and scores the exact answer. Two of the six scenarios look alarming but the right call is to proceed, so that stopping when unsure is measured instead of rewarded. In the runs recorded on 2026-10-28 and 2026-10-29 (UTC), the deputy model qwen3.8 scored 26 of 30 across five runs per scenario, and Sonnet scored 30 of 30; its stops all fell on one scenario about a security-gate change, scored as over-caution under the rule fixed before the run. The bench measures; which model is trusted with what is the owner's decision.

<p class="derived">This is built and working.</p>

## Why it is this way

**Honest Note**

SMALL SAMPLES, EXACT-MATCH SCORING. Five runs per scenario is a rate, not a verdict, and the score says whether the answer was the expected one, not how good the reasoning was. As of those measurements, gpt-oss had not been repeated because available memory was insufficient.
