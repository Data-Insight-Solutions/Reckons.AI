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

### MODERATE — protobufjs ≤ 7.6.2

**Package:** `protobufjs` (transitive: `@huggingface/transformers` → `onnxruntime-web` → `protobufjs`)

**CVE:** GHSA-f38q-mgvj-vph7 — Schema-derived names can shadow runtime-significant properties

**CVSS:** Moderate

**Risk in Reckons.AI:** LOW in practice. `protobufjs` is used internally by `onnxruntime-web` to parse ONNX model files. Reckons.AI only loads models from HuggingFace CDN (fixed URLs). No user-supplied `.proto` files are ever parsed.

**History:** Previously this was a CRITICAL (CVSS 9.8) chain via the deprecated `@xenova/transformers` → `onnxruntime-web ≤1.16` → `onnx-proto` → `protobufjs <7.5.5` (arbitrary code execution, GHSA-xq3m-2v4x-88gg / GHSA-66ff-xgx4-vchm). The migration to `@huggingface/transformers` v3 (onnxruntime-web 1.22+) removed the `onnx-proto` dependency and the critical CVEs. See Resolved section.

**Fix path:** Upstream `onnxruntime-web` fix required. Apply on next routine upgrade when available.

**Status:** Tracking — low practical risk, awaiting upstream.

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
| **WASM local inference** | Available as fallback | `@huggingface/transformers` v3 (onnxruntime-web) has a moderate transitive protobufjs advisory; models loaded only from HuggingFace CDN | Low practical risk — see protobufjs entry |

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

## Resolved: @xenova/transformers → @huggingface/transformers v3 Migration

**Goal:** Replace `@xenova/transformers` with `@huggingface/transformers` v3, resolving the critical protobufjs CVE chain.

**Status:** ✅ Complete (2026-07-01)

**Outcome:** Removed the direct `@xenova/transformers` v2 dependency. `@huggingface/transformers` v3.8.1 is now a direct dependency (previously only transitive via `kokoro-js`). This upgraded `onnxruntime-web` from ≤1.16 to 1.22+, removing the `onnx-proto` dependency and the CRITICAL (CVSS 9.8) protobufjs arbitrary-code-execution CVEs. A single MODERATE protobufjs advisory (GHSA-f38q-mgvj-vph7) remains from the modern onnxruntime-web chain, awaiting an upstream fix.

**Key differences (v2 → v3):**

| | @xenova/transformers v2 | @huggingface/transformers v3 |
|---|---|---|
| Import | `import { pipeline } from '@xenova/transformers'` | `import { pipeline } from '@huggingface/transformers'` |
| ONNX runtime | onnxruntime-web ≤1.16 (vulnerable, onnx-proto) | onnxruntime-web 1.22+ (actively maintained) |
| Model compatibility | HuggingFace ONNX models | Same + new quantized formats |
| WASM SIMD | Optional | Default |

**Migration checklist:**
- [x] Install `@huggingface/transformers` and remove `@xenova/transformers`
- [x] All imports already reference `@huggingface/transformers` (`embed.ts`, `wasm-worker.ts`, `whisper-stt.ts`, `offscreen.ts`, bench scripts)
- [x] Type-check passes (`npm run check` — 0 errors)
- [x] Verify `npm audit` clears the critical onnx-proto / protobufjs chain

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
