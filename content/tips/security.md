---
title: "Security and Privacy"
slug: "security"
order: 80
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

Reckons.AI is designed so that your data cannot leak by accident. The architecture makes security the default, not an afterthought.

<p class="derived">It has 11 parts below.</p>

## In this section

<details class="accordion"><summary>API Key Safety</summary>

API keys are sent directly from your browser to the provider (Claude, OpenAI, etc.). They never pass through any Reckons.AI infrastructure. Keys are excluded from .ttl exports and settings exports.

</details>

<details class="accordion"><summary>Content Safety System</summary>

All LLM prompts include an ethics preamble (hardcoded, not configurable). A content classifier filters blocked content on ingest and flags mature content on export with an advisory triple. Discourse, disagreement, and academic content pass freely.

</details>

<details class="accordion"><summary>Content Security Policy</summary>

The app enforces a strict CSP: no inline scripts beyond what SvelteKit requires, object-src none, form-action self. connect-src explicitly lists each allowed AI provider domain.

</details>

<details class="accordion"><summary>Data Classification Levels</summary>

All graph data stored in browser IndexedDB (origin-locked).

[Read more](../tips/data-classification)

</details>

<details class="accordion"><summary>Dependency Audit Process</summary>

Three free tools in use: npm audit (known CVEs in dependency tree), GitHub Dependabot (automated PRs for vulnerable deps — enable via Settings &gt; Security &gt; Dependabot), and GitHub Code Scanning via CodeQL (static analysis of source code).

[Read more](../tips/dependency-audit)

</details>

<details class="accordion"><summary>No Server = No Breach</summary>

There is no server to hack. Your data lives in your browser's IndexedDB. The app is a static file served from a CDN or your own machine. No database, no API endpoint, no attack surface.

</details>

<details class="accordion"><summary>No Telemetry Constraint</summary>

Reckons.AI collects zero telemetry, zero analytics, and performs zero third-party tracking.

[Read more](../tips/no-telemetry)

</details>

<details class="accordion"><summary>Offline Capable</summary>

After first load, the app works without internet. Use Ollama or the WASM model and zero inference traffic leaves your machine. Your graph is fully usable offline.

</details>

<details class="accordion"><summary>Risk Warnings for Integrations</summary>

Features with inherent risk are disabled by default and display a warning in Settings.

[Read more](../tips/risk-warnings)

</details>

<details class="accordion"><summary>Vulnerability Response Process</summary>

When a new vulnerability is reported (via npm audit, Dependabot alert, or public advisory): 1) Assess impact — is the vulnerable code path reachable?

[Read more](../tips/vulnerability-response)

</details>

<details class="accordion"><summary>XSS Protection</summary>

All {String.fromCharCode(123)}@html{String.fromCharCode(125)} usages are safe: TurtleChatPanel uses escHtml() before markdown, SearchBar uses escHtml() on all segments, NavBar renders hardcoded SVG, extension popup/sidepanel use template literals with no user input.

[Read more](../tips/xss-protection)

</details>

## Related

- [What Is Reckons.AI](../guide/what-is-reckons-ai)
