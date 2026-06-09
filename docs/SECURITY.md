# Security Policy

Vulnerability tracking, response process, and known issues for Reckons.AI.
Last updated: 2026-06-02

---

## Vulnerability Scanning

### Free Tools in Use

| Tool | How to run | What it covers |
|---|---|---|
| `npm audit` | `npm audit` | Known CVEs in npm dependency tree |
| GitHub Dependabot | Enable in repo Settings → Security → Dependabot | Automated PRs for vulnerable deps |
| GitHub Code Scanning | Enable Actions → Security → CodeQL | Static analysis of app source code |

### Enabling GitHub Dependabot

In the repository on GitHub:
1. Settings → Security → Code security and analysis
2. Enable "Dependency graph", "Dependabot alerts", "Dependabot security updates"

This creates automated PRs when a dependency has a published CVE fix.

### CI Audit Gate

Add to `.github/workflows/ci.yml` to block merges on high/critical findings:

```yaml
- name: Security audit
  run: npm audit --audit-level=high
```

---

## Current Known Vulnerabilities

Audit run: 2026-06-02 | `npm audit` — 10 total (1 critical, 4 high, 4 moderate, 1 low)

---

### CRITICAL — protobufjs < 7.5.5

**Package:** `protobufjs` (transitive: `@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs`)

**CVEs:**
- GHSA-xq3m-2v4x-88gg — Arbitrary code execution via crafted `.proto` files
- GHSA-66ff-xgx4-vchm — Code injection through bytes field defaults in generated toObject code

**CVSS:** 9.8 (Critical)

**Risk in Reckons.AI:** LOW in practice. `protobufjs` is used internally by `onnxruntime-web` to parse ONNX model files. Reckons.AI only loads models from HuggingFace CDN (fixed URLs). No user-supplied `.proto` files are ever parsed. An attacker would need to compromise the HuggingFace CDN or a MITM position to exploit this.

**Fix path:** `@xenova/transformers` v2.x has no fix available (the only "fix" npm suggests is downgrading to 2.0.1, which predates WASM support). The package is deprecated. Migration to `@huggingface/transformers` v3+ resolves this.

**Status:** Tracking — migration to `@huggingface/transformers` v3 planned. See Research section below.

---

### HIGH — devalue 5.6.3–5.8.0

**Package:** `devalue` (transitive via `@sveltejs/kit`)

**CVE:** GHSA-77vg-94rm-hx3p — DoS via sparse array deserialization

**CVSS:** 7.5 (High)

**Risk in Reckons.AI:** LOW. Reckons.AI is configured as a fully static SvelteKit app (`adapter-static`). Server-side `load()` functions and `devalue` serialization are not used in the deployed app. Devalue is a build-time/dev-server dependency only.

**Fix:** Upgrade `@sveltejs/kit` to a version that includes `devalue` > 5.8.0.

```bash
npm install @sveltejs/kit@latest
```

**Status:** Apply on next routine upgrade cycle.

---

### HIGH — @xenova/transformers (transitive protobufjs chain)

See CRITICAL protobufjs entry above. The high-severity rating propagates through the chain:
`@xenova/transformers` → `onnxruntime-web` → `onnx-proto` → `protobufjs`

**Status:** Same as protobufjs — tracked under migration to `@huggingface/transformers` v3.

---

### MODERATE — @sveltejs/kit query.batch cross-talk

**CVE:** GHSA-hgv7-v322-mmgr — Information disclosure via `query.batch` in SSR

**Range:** 2.38.0–2.60.0 (current: 2.59.1 — affected)

**Risk in Reckons.AI:** NONE. `adapter-static` is used; there is no SSR server. The vulnerability only affects SSR deployments where multiple concurrent requests share query state.

**Fix:** `npm install @sveltejs/kit@latest` (includes the cookie dep fix too).

**Status:** Apply on next routine upgrade.

---

### MODERATE — hume (internal uuid vulnerability)

**Package:** `hume` SDK depends on an older `uuid` version with a moderate-severity issue.

**Risk in Reckons.AI:** LOW. The `hume` SDK is lazy-loaded (only fetched when the user activates voice). The uuid vulnerability in hume's bundle does not affect our own uuid usage.

**Status:** Watch for `hume` patch release. Will auto-resolve when hume updates its own deps.

---

### LOW — cookie < 0.7.0

**CVE:** GHSA-pxg6-pf52-xh8x — Cookie name/path/domain accepts out-of-bounds characters

**Risk in Reckons.AI:** NONE. No server-side cookie handling exists in this app.

**Fix:** Resolved by upgrading `@sveltejs/kit`.

---

## Risk Warnings in the App

Integrations or features with inherent risk are disabled by default and display a warning in Settings.

| Feature | Default | Risk | Warning shown |
|---|---|---|---|
| **Voice (Hume.AI)** | Disabled — requires API key | Voice audio sent to Hume.AI cloud servers | Yes — Settings shows data leaves device |
| **QR Mobile Access** | Disabled — opt-in per session | Token-based auth; expires but still network-accessible | Yes — Settings warns about network exposure |
| **Cloud LLM backends** | Disabled — requires API key | Note text sent to third-party API | Yes — shown in backend selector |
| **WASM local inference** | Available as fallback | `@xenova/transformers` has known CVE in transitive deps | No in-app warning yet — see below |

### Planned: WASM security warning

Given the critical `protobufjs` CVE in the `@xenova/transformers` chain, the WASM backend will show an in-settings notice:

> "Local AI uses on-device inference via WebAssembly. The underlying ONNX runtime library has a known dependency vulnerability (protobufjs). Models are only loaded from HuggingFace CDN — no user data is affected. A dependency upgrade is in progress."

This will be added to the Settings → Backends section when the WASM backend is selected.

---

## Vulnerability Response Process

When a new vulnerability is reported (via `npm audit`, Dependabot alert, or public advisory):

1. **Assess impact** — Is the vulnerable code path reachable in Reckons.AI? Consider: SSR-only vs. static, lazy-loaded vs. always-bundled, user-supplied input vs. fixed sources.

2. **Document here** — Add an entry to this file under "Current Known Vulnerabilities" with severity, CVE, risk assessment, and fix path.

3. **If high/critical and exploitable:**
   - Open a GitHub issue tagged `security`
   - Disable the feature by default (add runtime check + settings warning)
   - Begin research into replacement package (document in "Research" section below)
   - Apply `npm audit fix` or pin a patched version

4. **If moderate/low and not exploitable in this context:**
   - Document it here
   - Apply the fix on the next routine dependency upgrade cycle

5. **When fixed:**
   - Remove from "Current Known Vulnerabilities", add to "Resolved" section with date

---

## Research: @xenova/transformers Migration

**Goal:** Replace `@xenova/transformers` with `@huggingface/transformers` v3, resolving the protobufjs CVE chain.

**Status:** In research

**Key differences (v2 → v3):**

| | @xenova/transformers v2 | @huggingface/transformers v3 |
|---|---|---|
| Import | `import { pipeline } from '@xenova/transformers'` | `import { pipeline } from '@huggingface/transformers'` |
| Worker support | Comlink-based manual worker | Built-in worker support |
| ONNX runtime | Bundled (older, vulnerable) | Updated, actively maintained |
| Model compatibility | HuggingFace ONNX models | Same + new quantized formats |
| WASM SIMD | Optional | Default |

**Migration checklist:**
- [ ] Install `@huggingface/transformers` and remove `@xenova/transformers`
- [ ] Update import path in `src/lib/llm/embed.ts` and `src/lib/llm/wasm.ts`
- [ ] Test embedding pipeline with `Xenova/all-MiniLM-L6-v2` (same model, same hub)
- [ ] Test text generation pipeline with `Xenova/Qwen2.5-0.5B-Instruct`
- [ ] Verify Comlink worker bridge still works or update to v3 worker API
- [ ] Run full Playwright test suite
- [ ] Verify `npm audit` clears protobufjs chain

---

## Application-Level Security Review

Last reviewed: 2026-06-05

### XSS Protection

| Pattern | Location | Status |
|---|---|---|
| `{@html renderMarkdown()}` | TurtleChatPanel.svelte | SAFE — uses `escHtml()` before markdown processing |
| `{@html highlight()}` | SearchBar.svelte | SAFE — uses `escHtml()` on all segments |
| `{@html it.svg}` | NavBar.svelte | SAFE — hardcoded SVG from source code |
| `innerHTML` | extension/popup.ts, sidepanel.ts | SAFE — template literals, no user input |

### Content Security Policy

CSP is configured in `src/app.html` via meta tag:
- `script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'` — `unsafe-inline` required for SvelteKit; `wasm-unsafe-eval` for ONNX Runtime
- `connect-src` explicitly lists each AI provider + `https:` catch-all for Ollama/custom endpoints
- `object-src 'none'`, `base-uri 'self'`, `form-action 'self'` — locked down

Fonts (Bespoke Stencil + Supreme from Fontshare) are self-hosted in `static/fonts/` — no external font requests.

### Data Storage Security

- All KB data in IndexedDB (origin-locked by browser)
- API keys stored in IndexedDB settings table (origin-locked, not in localStorage)
- `sessionStorage` used for per-tab KB selection (not shared across origins)
- `localStorage` used for KB registry (names and IDs only, no secrets)
- No cookies used

### API Key Handling

- Keys sent directly from browser to provider APIs (Claude, OpenAI, etc.)
- No server-side proxy — keys never transit through any Reckons.AI infrastructure
- Keys excluded from TTL exports and settings profile exports
- CSP `connect-src` limits which domains can receive API calls

### No Server-Side Attack Surface

- Built with `adapter-static` — no SSR, no server-side code
- No API routes (empty `src/routes/api/`)
- All LLM calls are client-side fetch requests

### Input Validation

- Turtle files parsed by N3.js (well-tested RDF parser)
- User text sent to LLMs for extraction (prompt injection mitigated by review step — all triples must be confirmed by user)
- File uploads handled by browser File API (no server upload)

## Resolved Vulnerabilities

| Package | CVE | Resolved | How |
|---|---|---|---|
| (none yet) | | | |
