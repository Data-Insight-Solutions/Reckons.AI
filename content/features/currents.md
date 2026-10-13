---
title: "Currents"
slug: "currents"
order: 1006
section: "Features"
parent: "what-is-reckons-ai"
template: doc
status: published
nav: sidebar
excerpt: "Currents brings recurring external content into a space through your optional n8n Currents Monitor."
generated: "docs-kb"
related:
  - "pod-view"
---

# Currents

> **Scaffolded** — the structure exists, but it is incomplete. Expect gaps.

Currents brings recurring external content into a space through your optional n8n Currents Monitor. Configure streams and an entity-type gate on the space management page, then explicitly connect Currents in Integrations. While the app is open, it sends saved current definitions and the space ID to your instance and checks for arrivals every minute. New document metadata enters the review queue as pending facts; repeated delivery preserves your decisions. Removing or disabling a current stops its remote schedule on the next successful sync. Disconnecting the browser or changing instances leaves existing server schedules running. The monitor workflow must be installed and active, allow this app through CORS, and be permitted by the build connection policy. A custom server needs a self-hosted build configured for its origin. Automatic ranking, direct RSS fallback and full-text extraction are not connected to this delivery path yet.

<p class="derived">This exists in outline, with gaps. It has one part below, 1 of which is not built yet.</p>

<p class="in-sets">Part of Take it in.</p>

## In this section

**[Pod View](../features/pod-view)** — **scaffolded**

Turn on the pod view from the Graph tab (currents section) to see arrivals -- nodes touched only by pending facts from a current -- drift gently at reduced opacity with a dashed halo, kept visually distinct until you accept or dismiss them from the node.

## Related

- [Pod View](../features/pod-view)
