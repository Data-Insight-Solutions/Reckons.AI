---
title: "Clear the \"graph-lint/incomplete\" cluster (5 pending findings)."
slug: "draft-0"
order: 0
section: "task-drafts"
template: doc
status: draft
nav: hidden
task: "urn:reckons:task/draft-0"
task_state: "open"
effect: []
done_when: "npx tsx scripts/offline/graph-lint.ts"
command: "npx tsx scripts/offline/describe-entities.ts"
---

# Clear the "graph-lint/incomplete" cluster (5 pending findings).

> **Not runnable.** no effect declaration — the runner cannot safely choose an authority boundary for this task

## Goal

Clear the "graph-lint/incomplete" cluster (5 pending findings).

## Before this can run

- [ ] `kpred:effect` — the authority boundary this may cross — one or more of read-only, queue-write, source-write, external-read, external-write

## State

| field | value |
| --- | --- |
| state | `open` |
| tier | `local-agent` |
| harness | `any` |
| done-when | `npx tsx scripts/offline/graph-lint.ts` |

---

_Generated from `urn:reckons:task/draft-0`. The graph is the source; edit the task there and regenerate._
