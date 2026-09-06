---
title: "Security and Privacy"
slug: "security"
order: 1012
section: "Tips"
template: doc
status: published
nav: sidebar
excerpt: "Reckons.AI is designed so that your data cannot leak by accident."
generated: "docs-kb"
related:
  - "what-is-reckons-ai"
---

# Security and Privacy

*Concept*

Reckons.AI is designed so that your data cannot leak by accident. The architecture makes security the default, not an afterthought.

## Where to go next

**[API Key Safety](../tips/api-key-safety)**

API keys are sent directly from your browser to the provider (Claude, OpenAI, etc.).

**[Content Safety System](../tips/content-safety-tips)**

All LLM prompts include an ethics preamble (hardcoded, not configurable).

**[Content Security Policy](../tips/csp)**

The app enforces a strict CSP: no inline scripts beyond what SvelteKit requires, object-src none, form-action self.

**[Data Classification Levels](../tips/data-classification)**

All graph data stored in browser IndexedDB (origin-locked).

**[Dependency Audit Process](../tips/dependency-audit)**

Three free tools in use: npm audit (known CVEs in dependency tree), GitHub Dependabot (automated PRs for vulnerable deps — enable via Settings &gt; Security &gt; Dependabot), and GitHub Code Scanning via CodeQL (static analysis of source code).

**[No Server = No Breach](../tips/no-server)**

There is no server to hack.

**[No Telemetry Constraint](../tips/no-telemetry)**

Reckons.AI collects zero telemetry, zero analytics, and performs zero third-party tracking.

**[Offline Capable](../tips/offline-capable)**

After first load, the app works without internet.

**[Risk Warnings for Integrations](../tips/risk-warnings)**

Features with inherent risk are disabled by default and display a warning in Settings.

**[Vulnerability Response Process](../tips/vulnerability-response)**

When a new vulnerability is reported (via npm audit, Dependabot alert, or public advisory): 1) Assess impact — is the vulnerable code path reachable?

**[XSS Protection](../tips/xss-protection)**

All {String.fromCharCode(123)}@html{String.fromCharCode(125)} usages are safe: TurtleChatPanel uses escHtml() before markdown, SearchBar uses escHtml() on all segments, NavBar renders hardcoded SVG, extension popup/sidepanel use template literals with no user input.

## Related

**Related**

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
