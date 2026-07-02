---
title: "No Telemetry Constraint"
slug: "no-telemetry"
order: 1008
section: "Tips"
parent: "security"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI collects zero telemetry, zero analytics, and performs zero third-party tracking."
generated: "docs-kb"
---

# No Telemetry Constraint

*Concept*

Reckons.AI collects zero telemetry, zero analytics, and performs zero third-party tracking. No server exists to receive telemetry. No analytics scripts are loaded. No tracking pixels. No usage data leaves the browser. This is an architectural constraint, not a policy — there is no server-side code in production (adapter-static). Fonts are self-hosted (no Google Fonts CDN). CSP connect-src explicitly lists only AI provider domains.
