---
title: "Trust checks for work done by a local helper"
slug: "agent-trust-checks"
order: 1059
section: "Features"
parent: "local-jobs-mcp"
template: doc
status: published
nav: sidebar
excerpt: "Three scripts, each a rule a computer can check, so they cost no model time."
generated: "docs-kb"
---

# Trust checks for work done by a local helper

Three scripts, each a rule a computer can check, so they cost no model time. Evidence: every claim in a helper's report that something works, passed or exists must carry, on the same line, the command, its exit code and the log line; a script marks a claim without them UNVERIFIED. Privacy: before a branch is merged, a script scans its changes, commit messages and branch name against a list of private terms you keep outside any repository, and prints counts and positions, never the terms. Cost: a passing job that needs no model is summarized from its exit code, duration and pass/fail lines, and a model reads a log only for a failure or a model-driven job; a second script fails if a passed rule-based run in the last day names a model.

## Why it is this way

**Honest Note**

BUILT AND TESTED ONLY ON SAMPLE DATA, AS OF 2026-11-10. No helper's brief yet asks for the evidence line format, and the merge step calls none of the three, so nothing stops a branch automatically. The privacy check is a literal, case-insensitive text match, so it can miss a reworded or split term, and it has not been run against the real list. The cost check is not yet a scheduled job.
