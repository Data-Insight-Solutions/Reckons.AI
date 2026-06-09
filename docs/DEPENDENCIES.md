# Dependency Analysis

Reckons.AI dependency health, browser support, and maintainability review.
Last updated: 2026-06-02

---

## Runtime Dependencies

| Package | Version | Docs quality | Maintainability | Notes |
|---|---|---|---|---|
| `svelte` | 5.55.5 | Excellent | Very high | Official Svelte, stable major version, active development |
| `@sveltejs/kit` | 2.59.1 | Excellent | Very high | Official SvelteKit, active, frequent releases |
| `vite` | 6.4.2 | Excellent | Very high | Industry standard build tool, extremely well-documented |
| `typescript` | 5.9.3 | Excellent | Very high | Microsoft-maintained, stable |
| `three` | 0.169.0 | Good | High | Mature 3D library (10+ years), large community, no breaking API drift |
| `dexie` | 4.4.2 | Good | High | De-facto IndexedDB ORM, stable API, responsive maintainer |
| `n3` | 1.26.0 | Moderate | Medium | RDF/Turtle parsing; well-tested but small community, low issue velocity |
| `uuid` | 10.0.0 | Excellent | High | Utility library, minimal surface, very stable |
| `qrcode` | 1.5.4 | Good | Medium | Stable, infrequent updates, no known concerns |
| `comlink` | 4.4.2 | Good | Medium | Google Chrome Labs project; small API, rarely needs updates |
| `@threlte/core` | 8.5.14 | Moderate | Medium | Svelte wrapper for Three.js; active but API still evolving |
| `@threlte/extras` | 9.17.1 | Moderate | Medium | Add-on for @threlte/core; breaking changes occur between minors |
| `bits-ui` | 2.18.1 | Moderate | Medium | Headless Svelte component primitives; active but relatively young |
| `@xenova/transformers` | 2.17.2 | Moderate | **Low** | **Deprecated** — superseded by `@huggingface/transformers` v3+. No new features. See SECURITY.md. |
| `hume` | 0.15.17 | Moderate | Medium | Official Hume AI SDK; lazy-loaded (not bundled by default). API stability improving. |

## Dev Dependencies

| Package | Version | Notes |
|---|---|---|
| `@playwright/test` | 1.60.0 | Official Playwright, industry standard for E2E testing |
| `vitest` | 4.1.7 | Vite-native unit testing, Chai/Jest compatible |
| `@sveltejs/vite-plugin-svelte` | 5.1.1 | Official bridge, kept in sync with Svelte version |
| `@vite-pwa/sveltekit` | 0.6.8 | PWA integration; thin wrapper over `vite-plugin-pwa` |
| `vite-plugin-pwa` | 0.21.2 | Workbox-based service worker generation, well-maintained |
| `svelte-check` | 4.4.8 | Type-checking for Svelte files, official toolchain |
| `jsdom` | 29.1.1 | DOM emulation for unit tests |
| `@types/chrome` | 0.0.325 | Browser extension type definitions, community-maintained |

---

## Browser Support Matrix

Features are grouped by the Web API they depend on.

### Core App — All modern browsers

| API | Chrome | Firefox | Safari | Edge | Notes |
|---|---|---|---|---|---|
| IndexedDB (Dexie) | 24+ | 16+ | 10+ | 12+ | Universal |
| Service Worker / PWA | 45+ | 44+ | 11.1+ | 17+ | Universal |
| Web Crypto (`crypto.subtle`) | 37+ | 34+ | 10.1+ | 12+ | Used for KB fingerprinting |
| WASM (`@xenova/transformers`) | 57+ | 52+ | 11+ | 16+ | WASM is universal |

### Advanced Features — Chromium-only or limited

| Feature | Chrome | Firefox | Safari | Edge | Notes |
|---|---|---|---|---|---|
| **File System Access API** | 86+ | No | No | 86+ | `workspace` folder sync. Not available on Firefox/Safari — graceful fallback to no-op in `workspace.svelte.ts` |
| **WebGPU** | 113+ | No | 18+ (partial) | 113+ | Used by `onnxruntime-web` for GPU WASM acceleration. Falls back to CPU WASM automatically. |
| **WebXR (AR/VR)** | 79+ | No | No | 79+ | `ARShell.svelte`, `VRShell.svelte`. Checks `navigator.xr` before activating. |
| **Web Audio API** | 35+ | 25+ | 6+ | 12+ | Used by Hume.AI voice (lazy-loaded). |
| **`indexedDB.databases()`** | 72+ | 126+ | 14+ | 79+ | Used in `clearStorage` test helper for cleanup. App does not depend on it. |

### Summary

- **Minimum supported**: Chrome 86+ / Edge 86+ for full feature set
- **Firefox**: Core KB features work. File System Access (workspace sync) unavailable. Voice unavailable (WebXR). WASM works.
- **Safari**: Core KB features work. File System Access unavailable. Voice partially available (Web Audio). WASM works.
- **Mobile Chrome/Edge**: Core KB + WASM work. File System Access unavailable on mobile.

---

## Novelty vs. Documented Technology

### Well-documented, large community

These packages have extensive StackOverflow coverage, official docs, and can be debugged with standard web searches:

- `svelte` / `@sveltejs/kit` — large community, official Discord, hundreds of tutorials
- `vite` / `vitest` — excellent official docs, huge community
- `three` / `@threlte/core` — Three.js has 15 years of documentation; Threlte wraps it with good docs
- `typescript` — Microsoft docs + DefinitelyTyped ecosystem
- `dexie` — good official docs at dexie.org, active forum
- `uuid`, `qrcode`, `comlink` — small, stable utilities; all well-documented

### Moderately documented

- `n3` (RDF/Turtle) — W3C specifications are the primary reference; n3.js docs are minimal but the RDF data model itself is stable and well-specified
- `bits-ui` — newer Svelte headless UI; docs are improving but some APIs are sparsely documented
- `hume` — official SDK docs exist but voice AI APIs change frequently

### Novel / potentially fragile

- **`@xenova/transformers`** — WASM-based in-browser LLM inference. The package is deprecated in favor of `@huggingface/transformers` v3. In-browser LLM is a rapidly evolving space with limited StackOverflow history. Most production apps still run inference server-side. The fallback to mock extraction means app functionality is preserved if this breaks.

- **`@vite-pwa/sveltekit`** — thin glue between Vite PWA plugin and SvelteKit routing. Service worker scope + SvelteKit's server-side routing interaction is a niche integration. Issues have historically required workarounds not found in standard documentation.

- **File System Access API** + **Dexie** combination for workspace sync — no prior art for this specific pattern. Custom code in `workspace.svelte.ts`.

---

## Replacement Candidates (Proactive)

| Current | Status | Recommended replacement | Urgency |
|---|---|---|---|
| `@xenova/transformers` | Deprecated | `@huggingface/transformers` v3 | Medium — functional but no new features |
| `three` r169 | Stable | Stay, monitor r170+ changelogs | Low |
| `bits-ui` v2 | Active | Monitor v3 roadmap | Low |

---

## Keeping Dependencies Current

```bash
# Check for outdated packages
npm outdated

# Run security audit
npm audit

# Apply safe (non-breaking) security fixes
npm audit fix

# Check a specific package's changelog before upgrading
npm info <package> versions
```

A CI step running `npm audit --audit-level=high` is recommended to block builds on high/critical vulnerabilities.
See `SECURITY.md` for the full vulnerability response process.
