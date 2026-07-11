/**
 * Turtle-from-URL detection (F72 kb:ttl-aware-ingest).
 *
 * A Reckons.AI-published page already IS a graph, so it can carry its own source
 * TTL. When Add-from-URL points at such a page we import the triples DIRECTLY —
 * no LLM extraction, no lossy prose re-modelling. This module does the detection
 * + fetch; the ingest store routes a hit through the existing importTurtleFull
 * pipeline as pending facts.
 *
 * Detection order (all best-effort, all CORS-permitting):
 *   1. URL ends in `.ttl` (or `.turtle`)                 → fetch it as text
 *   2. response Content-Type is text/turtle / x-turtle   → use the body
 *   3. HTML with <link rel="alternate" type="text/turtle"> → fetch that href
 *
 * Cross-origin fetches only succeed when the publisher sends permissive CORS
 * (which kb:published-ttl mandates for Reckons pages); anything blocked or
 * non-Turtle returns null and the caller falls back to the normal scrape+LLM
 * flow. Never throws.
 */

const TURTLE_CONTENT_TYPES = ['text/turtle', 'application/x-turtle', 'application/turtle'];

/** True when a URL's path clearly names a Turtle file. */
export function looksLikeTurtleUrl(url: string): boolean {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return p.endsWith('.ttl') || p.endsWith('.turtle');
  } catch {
    return /\.ttl(\?|#|$)/i.test(url);
  }
}

/** Extract the first <link rel="alternate" type="text/turtle" href="…"> href from
 * an HTML string, resolved against `baseUrl`. Returns null if none. */
export function extractAlternateTtlHref(html: string, baseUrl: string): string | null {
  // Scan every <link …> tag; match rel=alternate + a turtle type, in any order.
  const linkTags = html.match(/<link\b[^>]*>/gi) ?? [];
  for (const tag of linkTags) {
    const rel = /\brel\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase();
    const type = /\btype\s*=\s*["']?([^"'>\s]+)/i.exec(tag)?.[1]?.toLowerCase();
    if (rel !== 'alternate') continue;
    if (!type || !TURTLE_CONTENT_TYPES.includes(type)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try {
      return new URL(href, baseUrl).href;
    } catch {
      return href;
    }
  }
  return null;
}

/** Basic sanity check that a body is Turtle and not, e.g., an HTML error page. */
function looksLikeTurtleBody(body: string): boolean {
  const head = body.slice(0, 4000);
  if (/^\s*<!doctype html|^\s*<html/i.test(head)) return false;
  // @prefix / PREFIX / a bare IRI statement — any is a strong Turtle signal.
  return /@prefix\b|^\s*PREFIX\b|<[^>]+>\s+<[^>]+>|;\s*$|\.\s*$/m.test(head);
}

const isTurtleType = (ct: string | null): boolean =>
  !!ct && TURTLE_CONTENT_TYPES.some((t) => ct.toLowerCase().includes(t));

/**
 * Try to obtain source Turtle for `url`. Returns the TTL text on a confident hit,
 * or null to signal "not a graph — fall back to the normal flow". Never throws.
 * `fetchImpl` is injectable for tests.
 */
export async function fetchTurtleFromUrl(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(url, { headers: { Accept: 'text/turtle, text/html;q=0.5' } });
    if (!res.ok) return null;
    const ct = res.headers?.get?.('content-type') ?? null;
    const body = await res.text();

    // Direct Turtle: by extension or content-type.
    if (looksLikeTurtleUrl(url) || isTurtleType(ct)) {
      return looksLikeTurtleBody(body) ? body : null;
    }

    // HTML page: follow a rel=alternate turtle link.
    const alt = extractAlternateTtlHref(body, url);
    if (alt) {
      const altRes = await fetchImpl(alt, { headers: { Accept: 'text/turtle' } });
      if (!altRes.ok) return null;
      const altBody = await altRes.text();
      return looksLikeTurtleBody(altBody) ? altBody : null;
    }

    return null;
  } catch {
    // CORS-blocked, network error, non-text body, etc. — not a Turtle source.
    return null;
  }
}
