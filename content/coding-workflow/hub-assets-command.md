---
title: "Giving the busiest topics a picture and a 3D view, from the command line"
slug: "hub-assets-command"
order: 121
section: "Coding Workflow"
parent: "coding-workflow"
template: doc
status: published
nav: sidebar
excerpt: "A hub is a topic that many statements connect to."
generated: "docs-kb"
---

# Giving the busiest topics a picture and a 3D view, from the command line

> **In progress** — actively being built. Parts of what follows may not work yet.

A hub is a topic that many statements connect to. npm run assets:hubs picks the hubs that still lack a picture, 3D splat or model, and for each one queues two jobs in the local job queue: an image whose prompt is built only from that hub's confirmed statements, then a splat (a 3D view built from many angles) that may start only from the image. The planning step is a plain script and uses no language model. Add --dry-run to see the plan without queueing anything, and --limit=N to cap how many hubs it handles. A hub with no confirmed statement beyond its name is refused, and a hub that is a person gets a neutral portrait that names no one.

<p class="derived">This is being built now.</p>

## Why it is this way

**Honest Note**

COMMAND LINE ONLY, NOT AUTOMATIC. Nothing queues these jobs by itself yet, so every hub still needs a person to run the command. The first real run queued 4 jobs for the 2 hubs in the quickstart example, and the finished pictures and splats were not checked when the job was written. Keeping a result is only half built: a request now names its hub and a kept result adds pending picture and splat rows to it (unit-tested), but the app does not learn about a job the command queued until its folder is connected, and that wiring is not built. Whether this should be on by default for every collection is an open question.
