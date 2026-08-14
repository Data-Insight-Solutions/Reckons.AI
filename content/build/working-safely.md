---
title: "Working safely"
slug: "working-safely"
order: 6
section: "Build"
template: doc
status: published
nav: sidebar
excerpt: "Keeping a graph trustworthy: what stays on your machine, what leaves, and how facts get checked."
generated: "docs-composed"
---

# Working safely

Keeping a graph trustworthy: what stays on your machine, what leaves, and how facts get checked.

### API Key Safety

API keys are sent directly from your browser to the provider (Claude, OpenAI, etc.). They never pass through any Reckons.AI infrastructure. Keys are excluded from .ttl exports and settings exports.

### Content Safety System

All LLM prompts include an ethics preamble (hardcoded, not configurable). A content classifier filters blocked content on ingest and flags mature content on export with an advisory triple. Discourse, disagreement, and academic content pass freely.

### Content Security Policy

The app enforces a strict CSP: no inline scripts beyond what SvelteKit requires, object-src none, form-action self. connect-src explicitly lists each allowed AI provider domain.

### Data Classification Levels

All graph data stored in browser IndexedDB (origin-locked). API keys stored in IndexedDB settings table (origin-locked, not in localStorage). sessionStorage for per-tab graph selection (not shared across origins). localStorage for graph registry (names and IDs only, no secrets). No cookies used. Keys sent directly from browser to provider APIs — never transit through Reckons.AI infrastructure. Keys excluded from TTL exports and settings profile exports.

### Dependency Audit Process

Three free tools in use: npm audit (known CVEs in dependency tree), GitHub Dependabot (automated PRs for vulnerable deps — enable via Settings &gt; Security &gt; Dependabot), and GitHub Code Scanning via CodeQL (static analysis of source code). CI gate: npm audit --audit-level=high blocks merges on high/critical findings.

### Export Often

Your .ttl export is your insurance policy. Export regularly. Keep backups. The file is plain text -- it will outlast any app, any platform, any company.

### Name Entities Well

Use clear, specific entity names. 'Q3 2025 Revenue Report' is better than 'Report'. Good names make the graph navigable and Shelly's answers more precise.

### No Server = No Breach

There is no server to hack. Your data lives in your browser's IndexedDB. The app is a static file served from a CDN or your own machine. No database, no API endpoint, no attack surface.

### No Telemetry Constraint

Reckons.AI collects zero telemetry, zero analytics, and performs zero third-party tracking. No server exists to receive telemetry. No analytics scripts are loaded. No tracking pixels. No usage data leaves the browser. This is an architectural constraint, not a policy — there is no server-side code in production (adapter-static). Fonts are self-hosted (no Google Fonts CDN). CSP connect-src explicitly lists only AI provider domains.

### Offline Capable

After first load, the app works without internet. Use Ollama or the WASM model and zero inference traffic leaves your machine. Your graph is fully usable offline.

### Review Carefully

The quality of your graph depends entirely on the quality of your review. Reject inaccurate triples. Refine ambiguous ones. A smaller graph of confirmed facts is far more valuable than a large graph of unreviewed noise.

### Risk Warnings for Integrations

Features with inherent risk are disabled by default and display a warning in Settings. Voice (Hume.AI): audio sent to cloud, warning shown. QR Mobile Access: token-based auth with expiry, warning shown. Cloud LLM backends: note text sent to third-party API, warning shown in backend selector. WASM local inference: transitive protobufjs CVE in dependency chain — models loaded only from HuggingFace CDN, no user data affected.

### Security and Privacy

Reckons.AI is designed so that your data cannot leak by accident. The architecture makes security the default, not an afterthought.

See also: [Start here](/docs/learn/start-here)

### Share Your .ttl

Export your graph and share the .ttl file. Recipients can import it and see a semantic diff against their own graph. Collaboration through structured knowledge exchange -- no real-time sync needed.

See also: [What it does](/docs/learn/what-it-does)

### Start Small

Begin with one document or topic you care about. Ingest it, review the triples, confirm the accurate ones. Your graph grows naturally with each source you add. Over time, connections emerge that you never would have seen reading documents linearly.

### Tips and Tricks

Practical advice for getting the most out of Reckons.AI.

See also: [Start here](/docs/learn/start-here)

### Use Ollama for Offline

Install Ollama on your machine for fully local, fully offline LLM inference. Zero data leaves your device. Good models: llama3.2, mistral, phi3.

See also: [What it does](/docs/learn/what-it-does)

### Use Source Trust

Mark reliable sources as trusted to auto-confirm future imports from them. But start conservative -- trust is earned through consistent accuracy.

### Vulnerability Response Process

When a new vulnerability is reported (via npm audit, Dependabot alert, or public advisory): 1) Assess impact — is the vulnerable code path reachable? Consider SSR-only vs static, lazy-loaded vs always-bundled, user-supplied input vs fixed sources. 2) Document in SECURITY.md with severity, CVE, risk assessment, and fix path. 3) If high/critical and exploitable: open GitHub issue tagged security, disable the feature by default, begin research into replacement, apply npm audit fix. 4) If moderate/low and not exploitable: document and apply on next routine upgrade. 5) When fixed: move to Resolved section with date.

### XSS Protection

All {String.fromCharCode(123)}@html{String.fromCharCode(125)} usages are safe: TurtleChatPanel uses escHtml() before markdown, SearchBar uses escHtml() on all segments, NavBar renders hardcoded SVG, extension popup/sidepanel use template literals with no user input. Input validation: Turtle files parsed by N3.js, user text sent to LLMs for extraction has prompt injection mitigated by mandatory review step (all triples must be confirmed by user), file uploads handled by browser File API (no server upload).
