/**
 * Pure token-validation logic for the /mobile QR-code landing page.
 *
 * Extracted from the Svelte component so it can be unit-tested without
 * a browser environment.
 */

import type { MobileSession } from '$lib/storage/db';

export type MobileTokenResult =
  | { state: 'valid';   session: MobileSession }
  | { state: 'invalid'; reason: string }
  | { state: 'expired'; reason: string };

/**
 * Validate a QR-code token.
 *
 * Tokens are self-validating from the URL — expiry check + UUID format only.
 * Session-list lookup is NOT used for validation because the desktop stores
 * sessions in IndexedDB under origin `localhost:5173`, while the mobile browser
 * opens `192.168.x.x:5173` — a different origin with its own empty database.
 *
 * Security model: v4 UUID (122 bits entropy) + expiry + private LAN.
 * The session list in settings is kept for the desktop "active sessions" UI only.
 *
 * @param token    The `token` URL param (null if absent).
 * @param expires  The `expires` URL param — authoritative expiry timestamp (ms).
 * @param sessions Kept for API compatibility; not used for validation.
 * @param now      Current timestamp in ms (injectable for testing).
 */
export function validateMobileToken(
  token: string | null,
  expires: string | null,
  sessions: MobileSession[],
  now: number = Date.now()
): MobileTokenResult {
  if (!token) {
    return { state: 'invalid', reason: 'No token in URL. Scan a fresh QR code from Settings → Integrations.' };
  }

  // Token must look like a UUID v4 — rules out random URL manipulation.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(token)) {
    return { state: 'invalid', reason: 'Malformed token. Scan a fresh QR code from Settings → Integrations.' };
  }

  if (expires === null) {
    return { state: 'invalid', reason: 'No expiry in URL. Scan a fresh QR code from Settings → Integrations.' };
  }

  const exp = parseInt(expires, 10);
  if (isNaN(exp)) {
    return { state: 'invalid', reason: 'Invalid expiry in URL. Scan a fresh QR code from Settings → Integrations.' };
  }

  if (exp < now) {
    return { state: 'expired', reason: 'This QR code has expired. Generate a new one from the desktop.' };
  }

  // Valid: UUID format confirmed, expiry is in the future.
  // Synthesise a minimal session record so callers don't need to change.
  const syntheticSession: MobileSession = { id: token, token, createdAt: now, expiresAt: exp };
  return { state: 'valid', session: syntheticSession };
}

/**
 * Build the full access URL for a QR code.
 * Returns null if host is empty.
 */
export function buildAccessUrl(host: string, port: string, token: string, expiresAt: number): string | null {
  const h = host.trim();
  const p = port.trim();
  if (!h) return null;
  return `http://${h}:${p}/mobile?token=${encodeURIComponent(token)}&expires=${expiresAt}`;
}
