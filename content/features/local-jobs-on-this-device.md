---
title: "Local jobs: the one queue, This device and the memory guard"
slug: "local-jobs-on-this-device"
order: 1029
section: "Features"
parent: "local-jobs-mcp"
template: doc
status: published
nav: sidebar
excerpt: "Work that runs on your own computer goes through one queue."
generated: "docs-kb"
---

# Local jobs: the one queue, This device and the memory guard

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

Work that runs on your own computer goes through one queue. The definitions of those jobs (name, tier, schedule) now live in a plain text file, static/reckons-jobs.ttl, which is what the tools read; the old JSON copy is no longer the master. The queue worker looks at the computer's memory as well as the graphics card: a graphics job waits while less than 6 GiB of RAM is free, and if the Ollama service starts holding more than 6 GiB (a sign a model is loading into RAM instead of onto the card) or free RAM falls under 2 GiB, the worker stops that job, unloads the models and pauses the queue until you resume it. Ollama now runs the model you have installed: a bare name such as llama3.2 becomes the installed tag, and if the model you chose is missing, the best installed one runs and a warning names both and the ollama pull command that fixes it. Shelly can queue generation: a request for a picture, clip or 3D asset becomes a job in the same queue, shown in the collection as a job card (prompt, stage, seed, state, what it waits for, the asset it made), and a chain such as three images then a splat is approved once, not once per step. This device is meant to be a private collection where each job can be read in full: its state, why it is held, what it waits on and its recent runs.

<p class="derived">This exists in outline, with gaps.</p>

## Why it is this way

**Honest Note**

THIS DEVICE DOES NOT EXIST YET. Only the writer and reader code is built and tested on sample records; the collection itself is not created, nothing schedules the writer, and its output location is a placeholder. Generation needs the local runner (npm run gen:serve) running on your machine; without it Shelly has nothing to queue to. Shelly writing a valid job plan has been tested only with a stand-in reply, not a real model, and the card shows Queued or Waiting, not how many jobs are ahead. A recurring job cannot yet be told to allow a model larger than the card; only a hand-added job can. The Ollama substitution notice needs a first successful check of what is installed; before that, nothing is substituted or announced.
