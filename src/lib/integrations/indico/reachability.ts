/**
 * Turning "TypeError: Failed to fetch" into something a user can act on.
 *
 * A browser refuses a cross-origin request in two places, and reports NEITHER to the calling code:
 *
 *   1. Content-Security-Policy — the request is never sent, because the origin is not in
 *      `connect-src`. A `securitypolicyviolation` event fires on the document, which is the only
 *      way the app can know this happened.
 *   2. CORS — the request IS sent and the server DOES answer, but the response lacks
 *      `Access-Control-Allow-Origin` for this page's origin, so the browser discards it before
 *      the app can look. Nothing observable distinguishes this from the server being down.
 *
 * In both cases `fetch()` rejects with a bare `TypeError: Failed to fetch` — no status, no
 * message, no reason. That is what the Indico panel was showing users (measured 2026-07-31
 * against a live Indico 3.x server), and it is indistinguishable from "your URL is wrong".
 *
 * The distinction matters because the REMEDIES are completely different and neither is guessable:
 * CSP is fixed by rebuilding this app with the server URL configured; CORS is fixed on the
 * Indico server, which Indico does not do by default.
 *
 * (Candidate to lift into the Integration Plugin SDK (F61) once n8n/Nextcloud need it — it is
 * kept here rather than generalised early because it has only been proven against Indico.)
 */

/** True when running in a browser, where CSP and CORS are enforced at all. */
function inBrowser(): boolean {
  return typeof document !== 'undefined' && typeof document.addEventListener === 'function';
}

/**
 * Watch for a CSP violation naming `origin` while a request is in flight.
 * Returns a probe whose `blocked` is true if the policy refused that origin.
 *
 * No-op outside a browser: Node enforces neither policy, so claiming either there would be a
 * confident lie about the wrong layer.
 */
export function watchCspViolations(origin: string): { blocked: () => boolean; stop: () => void } {
  if (!inBrowser()) return { blocked: () => false, stop: () => {} };

  let blocked = false;
  const onViolation = (e: Event) => {
    const ev = e as SecurityPolicyViolationEvent;
    if (ev.effectiveDirective?.startsWith('connect-src') && ev.blockedURI?.startsWith(origin)) {
      blocked = true;
    }
  };

  document.addEventListener('securitypolicyviolation', onViolation);
  return {
    blocked: () => blocked,
    stop: () => document.removeEventListener('securitypolicyviolation', onViolation)
  };
}

export interface BlockDescription {
  /** Which layer refused, as far as can be determined. */
  cause: 'csp' | 'cors-or-network' | 'network';
  message: string;
}

/**
 * Explain a failed request in terms of the layer that refused it and the fix that layer needs.
 * `appOrigin` is the page's own origin — the value the server must name in its CORS header.
 */
export function describeUnreachable(opts: {
  serverOrigin: string;
  appOrigin: string | null;
  cspBlocked: boolean;
  cause?: unknown;
}): BlockDescription {
  const { serverOrigin, appOrigin, cspBlocked, cause } = opts;

  if (cspBlocked) {
    return {
      cause: 'csp',
      message:
        `Blocked by this app's Content-Security-Policy — the request to ${serverOrigin} was never sent. ` +
        `That origin is not listed in connect-src, and the policy cannot be widened while the app is running. ` +
        `Fix: build the app with VITE_INDICO_SERVER_URL=${serverOrigin} set (see .env.example); ` +
        `src/hooks.server.ts adds configured origins to the policy at build time.`
    };
  }

  if (!appOrigin) {
    return {
      cause: 'network',
      message:
        `Could not reach ${serverOrigin}: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `Check the server URL and that the host is reachable.`
    };
  }

  return {
    cause: 'cors-or-network',
    message:
      `Could not read a response from ${serverOrigin}. The request left the browser, but the reply was ` +
      `discarded before this app could see it — the browser reports only "Failed to fetch", with no status ` +
      `or reason. The usual cause is CORS: ${serverOrigin} did not return an ` +
      `Access-Control-Allow-Origin header naming ${appOrigin}, and Indico does not send one by default. ` +
      `Fix it on the Indico server (or its reverse proxy), not here. ` +
      `The API itself may be perfectly healthy — check with ` +
      `\`npx tsx scripts/offline/indico-verify.ts --server=${serverOrigin}\`, which calls it from Node, ` +
      `where CORS is not enforced. A server that is genuinely down or misnamed fails the same way.`
  };
}

/** The page's own origin, or null outside a browser. */
export function currentAppOrigin(): string | null {
  return typeof location !== 'undefined' && location.origin && location.origin !== 'null'
    ? location.origin
    : null;
}
