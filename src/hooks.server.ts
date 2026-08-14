import type { Handle } from '@sveltejs/kit';
import {
  extraConnectSrc,
  fillConnectSrcPlaceholder,
  CONNECT_SRC_PLACEHOLDER
} from '../scripts/offline/csp-connect-src';

/**
 * Widen the app.html Content-Security-Policy with the SELF-HOSTED origins this build is
 * configured for (Indico, n8n, a non-localhost Ollama, VITE_EXTRA_CONNECT_SRC).
 *
 * WHY HERE AND NOT IN A VITE PLUGIN: `src/app.html` is SvelteKit's template, not a Vite HTML
 * entry, so `transformIndexHtml` never runs on it — a plugin computes the right answer and
 * silently fails to apply it (verified 2026-07-31: the placeholder shipped verbatim). This hook
 * runs in dev SSR and again when adapter-static renders the prerendered pages and the SPA
 * fallback, so dev and the built site agree.
 *
 * `import.meta.env` is the right source: Vite inlines VITE_* at build time, so the value baked
 * into the CSP is by construction the same one the client code reads for the integration itself.
 *
 * The rationale for substituting ORIGINS ONLY (never paths) is in
 * scripts/offline/csp-connect-src.ts.
 */
const EXTRA_CONNECT_SRC = extraConnectSrc(import.meta.env as Record<string, string | undefined>);

export const handle: Handle = async ({ event, resolve }) =>
  resolve(event, {
    transformPageChunk: ({ html }) =>
      // The placeholder sits in <head>, which SvelteKit emits in the first chunk, so a plain
      // per-chunk replace is sufficient. The guard keeps this a no-op for every later chunk
      // rather than paying for a scan of the whole body.
      html.includes(CONNECT_SRC_PLACEHOLDER)
        ? fillConnectSrcPlaceholder(html, EXTRA_CONNECT_SRC)
        : html
  });
