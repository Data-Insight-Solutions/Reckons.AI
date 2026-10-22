---
title: "Agent setup and installation permissions"
slug: "agent-setup"
order: 1004
section: "Features"
parent: "story-system"
template: doc
status: published
nav: sidebar
excerpt: "An external coding or automation agent can help install generation tools, plugins, or an optional integration when you give it the appropriate terminal or SSH access."
generated: "docs-kb"
---

# Agent setup and installation permissions

An external coding or automation agent can help install generation tools, plugins, or an optional integration when you give it the appropriate terminal or SSH access. Reckons.AI's browser story does not provide that agent, grant access, install services or hold SSH credentials.

### Start with a limited task

1. Configure your chosen agent using its own setup instructions. If it should read Reckons.AI graphs, connect [the MCP server](/docs/integrations-tech/mcp-server). Reading a graph is separate from permission to run its commands.
2. Give it the specific installation guide and desired result: for example, install the local image/splat tools, configure your own Indico calendar service, or connect your own n8n webhook. Ask for an inspectable plan naming downloads, licenses, disk/GPU requirements, configuration changes, ports and rollback steps.
3. Approve only the necessary effect on the chosen device or server. **Warning: terminal/device control can read or change accessible files, run downloaded code and install software. SSH access extends that authority to the remote account. Elevated privileges can affect the whole machine.** Use a dedicated account with limited permissions, keep backups, and never put passwords, private keys or tokens in a shared graph or prompt example.
4. Let the authorized agent perform the approved installation, then verify the result independently: a checked generated image, a successful read from the configured calendar, or a synthetic webhook test. Review logs and failures. Revoke temporary credentials and remove unneeded privileges when finished.

Reckons.AI includes a developer task runner at `scripts/agent/runner.ts`. For a trusted local task graph, `npx tsx scripts/agent/runner.ts --graph=/path/to/tasks.ttl --dry-run` shows planned work. Its default declared authority is read-only; broader effects must be allowed explicitly. Effect declarations are not an operating-system sandbox. Do not run task graphs supplied by strangers or grant broad effects merely to bypass a failure. The dedicated generation runner is narrower: it accepts fixed generation stages, not graph-authored shell commands.

### Optional service setup

[Indico installation](https://docs.getindico.io/en/stable/installation/) and [n8n hosting](https://docs.n8n.io/deploy/host-n8n/) are service-specific guides. An authorized external agent with appropriate SSH access can follow them on a server you control; server provisioning is not a built-in Reckons.AI feature. Connect the resulting service through [Integrations settings](/settings/integrations). These services are optional and per-user. Reckons.AI remains usable without either server.

For model jobs, see [the local agent tier](/docs/coding-workflow/agent-tier). The broader [portable orchestration design](/docs/coding-workflow/agent-orchestration) and in-app agent dashboard remain planned; they are not prerequisites for an external agent helping you with an approved install.
