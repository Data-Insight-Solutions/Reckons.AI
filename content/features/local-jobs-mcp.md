---
title: "Local jobs through MCP"
slug: "local-jobs-mcp"
order: 1024
section: "Features"
parent: "mcp-workspace"
template: doc
status: published
nav: sidebar
excerpt: "Long-running work (an e2e suite, a benchmark, a research or batch-analysis run) belongs on the local job queue, not inline on a cloud model."
generated: "docs-kb"
---

# Local jobs through MCP

> **In progress** — actively being built. Parts of what follows may not work yet.

Long-running work (an e2e suite, a benchmark, a research or batch-analysis run) belongs on the local job queue, not inline on a cloud model. Three tools on the MCP server reach that queue: kb_job_list shows every defined job with its tier, what it does and its last run; kb_job_enqueue(name, args?) queues one by name and returns a queue id; kb_job_status(id or name) reports queued, running, done or failed with the exit code, the last 40 log lines and where the full log is. Only jobs defined in scripts/offline/jobs.json or the schedules file can be queued, never a command. Queueing works with no worker running: the job waits until npm run agent:watch starts the worker. Not built yet: a hook that stops a foreground long-running command and names these tools, and defining a job in the app UI.

<p class="derived">This is being built now.</p>
