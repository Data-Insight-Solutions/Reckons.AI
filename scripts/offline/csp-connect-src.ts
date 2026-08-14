/**
 * Build-time widening of the `connect-src` CSP directive for SELF-HOSTED integrations.
 *
 * WHY THIS EXISTS
 * ---------------
 * `src/app.html` ships a locked-down Content-Security-Policy in a <meta> tag. Every origin the
 * browser is allowed to call must be listed there literally. That works for the fixed provider
 * APIs (Anthropic, HuggingFace, …) and breaks completely for the bring-your-own-server
 * integrations — Indico, n8n, Ollama on a non-localhost box — because THOSE URLS ARE PER-USER
 * and cannot be known when this repository is written.
 *
 * A <meta> CSP also cannot be widened at runtime: by the time the app reads the user's configured
 * Indico URL out of settings, the policy is already enforced. So a self-hosted integration
 * configured purely in-app is blocked before the app ever sees it, and `fetch()` reports only
 * `TypeError: Failed to fetch` — no status, no reason. (Measured 2026-07-31 against a real Indico
 * 3.x server: the request was refused by `connect-src` and the app showed nothing useful.)
 *
 * The fix is to substitute the origins THIS BUILD is configured for into the policy at build time.
 * That covers the two cases that matter — local development, and a user building/self-hosting
 * their own copy — and it is honest about the case it does NOT cover: on a shared hosted build,
 * a user's arbitrary Indico server still cannot be reached from the browser. That is a real limit
 * of static hosting, recorded rather than papered over.
 *
 * WHAT IS SUBSTITUTED
 * -------------------
 * Only the ORIGIN (scheme + host + port) of each configured URL, never the path. This is
 * deliberate and load-bearing: `VITE_FEEDBACK_WEBHOOK_URL` carries a secret-ish webhook path, and
 * the CSP is public in the shipped HTML. Reducing to the origin keeps the path out of the bundle.
 */

/**
 * Env vars whose values are URLs of servers THE BROWSER CALLS DIRECTLY.
 *
 * API keys are deliberately absent — a key is not an origin. `VITE_EXTRA_CONNECT_SRC` is the
 * escape hatch for anything not modelled here (space- or comma-separated).
 */
export const CONNECT_SRC_ENV_VARS = [
  'VITE_INDICO_SERVER_URL',
  'VITE_N8N_BASE_URL',
  'VITE_OLLAMA_BASE_URL',
  'VITE_RECKONS_BASE_URL',
  'VITE_FEEDBACK_WEBHOOK_URL',
  'VITE_EXTRA_CONNECT_SRC'
] as const;

export const CONNECT_SRC_PLACEHOLDER = '%RECKONS_EXTRA_CONNECT_SRC%';

/**
 * Reduce a URL to a CSP source expression: scheme://host[:port].
 * Returns null for anything that is not an absolute http(s)/ws(s) URL — a relative path, a bare
 * hostname or a typo must NOT silently widen the policy.
 */
export function originOf(value: string | undefined | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return null;
  if (!url.hostname) return null;

  return url.port ? `${url.protocol}//${url.hostname}:${url.port}` : `${url.protocol}//${url.hostname}`;
}

/**
 * Collect the extra origins this build should allow, deduped and sorted (sorted so a build is
 * byte-reproducible regardless of env ordering).
 */
export function extraConnectSrc(env: Record<string, string | undefined>): string[] {
  const origins = new Set<string>();

  for (const name of CONNECT_SRC_ENV_VARS) {
    // One var may hold several entries; the rest hold one. Splitting unconditionally is harmless
    // because a single URL contains neither a space nor a comma.
    for (const part of (env[name] ?? '').split(/[\s,]+/)) {
      const origin = originOf(part);
      if (origin) origins.add(origin);
    }
  }

  return [...origins].sort();
}

/**
 * Replace the placeholder in app.html with the resolved origins.
 *
 * If there are none the placeholder becomes empty — leaving the literal `%RECKONS_EXTRA_...%`
 * token inside `connect-src` would be an invalid source expression, which is exactly the broken
 * state this file was written to end.
 */
export function fillConnectSrcPlaceholder(html: string, origins: string[]): string {
  if (!html.includes(CONNECT_SRC_PLACEHOLDER)) return html;

  // Consume the separating space along with the placeholder, so an empty result leaves no
  // double space behind and the emitted policy is clean rather than merely valid.
  const replacement = origins.length ? ` ${origins.join(' ')}` : '';
  return html.split(` ${CONNECT_SRC_PLACEHOLDER}`).join(replacement)
             .split(CONNECT_SRC_PLACEHOLDER).join(origins.join(' '));
}
