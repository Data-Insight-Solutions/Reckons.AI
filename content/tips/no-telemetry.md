---
title: "No Telemetry Constraint"
slug: "no-telemetry"
order: 1008
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "NO PERSONAL TELEMETRY."
generated: "docs-kb"
---

# No Telemetry Constraint

NO PERSONAL TELEMETRY. Nothing is gathered at a per-user level, and the app itself collects nothing — no server exists to receive it. This is an architectural constraint, not a policy: there is no server-side code in production (adapter-static). Your graph, your notes and your API keys never leave the browser. No cookies, no persistent identifier, no fingerprinting, no cross-site tracking, no advertising or data-broker third parties. Fonts are self-hosted (no Google Fonts CDN). THE ONE THING MEASURED, STATED PLAINLY: the public website counts visits in aggregate through Cloudflare Web Analytics, which Cloudflare Pages injects into the served HTML. It is cookieless and records, per request, the page URL, referrer, country, browser/OS and load timing. It is never tied to a person, never linked across sites, and it observes nothing you do inside your graph — it measures the marketing and docs pages, not the app. CSP script-src and connect-src list the AI provider, model-host and content-fetch domains the app calls, plus static.cloudflareinsights.com — view source and check.
