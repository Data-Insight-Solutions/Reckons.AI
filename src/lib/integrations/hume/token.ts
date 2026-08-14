/**
 * Hume EVI authentication planning + delegated token fetch (F107.6).
 *
 * Sharing a voice safely turns on ONE distinction: a Hume API/secret key authorizes full,
 * billable account use and never leaves its owner; a short-lived ACCESS TOKEN is a scoped,
 * expiring bearer credential that is safe to use client-side. To let a viewer hear a shared
 * persona without configuring their own Hume, the sharer runs a token endpoint that mints those
 * short-lived tokens; the viewer's client fetches one at play-time. The secret key stays on the
 * sharer's side, and the delegation is revocable and rate-limitable — unlike a leaked key.
 *
 * `planHumeAuth` is pure (no SDK, no network) so the precedence is unit-testable; the component
 * executes the chosen method.
 */

export type HumeAuthInputs = {
  apiKey?: string;
  secretKey?: string;
  /** Opt-in endpoint returning a short-lived access token (the shared-voice path). */
  tokenUrl?: string;
};

export type HumeAuthPlan =
  /** Owner has both keys: mint a short-lived token locally (best — no raw key on the wire). */
  | { method: 'mint-local'; apiKey: string; secretKey: string }
  /** Owner has only an API key: connect with it directly. */
  | { method: 'api-key'; apiKey: string }
  /** No local credentials, but a shared persona carries a delegated token endpoint. */
  | { method: 'token-url'; tokenUrl: string }
  /** Nothing usable — the caller should fall back to local TTS. */
  | { method: 'none' };

const trimmed = (v?: string): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Decide how to authenticate to Hume EVI, preferring the caller's OWN credentials over a shared
 * delegation endpoint, and never requiring a secret key on the viewer side.
 */
export function planHumeAuth(inputs: HumeAuthInputs): HumeAuthPlan {
  const apiKey = trimmed(inputs.apiKey);
  const secretKey = trimmed(inputs.secretKey);
  const tokenUrl = trimmed(inputs.tokenUrl);

  if (apiKey && secretKey) return { method: 'mint-local', apiKey, secretKey };
  if (apiKey) return { method: 'api-key', apiKey };
  if (tokenUrl) return { method: 'token-url', tokenUrl };
  return { method: 'none' };
}

/**
 * Fetch a short-lived Hume access token from a sharer-run endpoint. Accepts the common shapes
 * (`{ accessToken }`, `{ access_token }`, `{ token }`). Throws with a clear message on any
 * failure so the caller can fall back to local TTS rather than hang.
 */
export async function fetchHumeTokenFromUrl(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const endpoint = trimmed(url);
  if (!endpoint) throw new Error('no Hume token endpoint configured');

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error(`invalid Hume token endpoint URL: ${endpoint}`);
  }
  // A token grants account access; only fetch it over TLS (localhost excepted for dev).
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new Error('Hume token endpoint must use https');
  }

  let res: Response;
  try {
    res = await fetchImpl(endpoint, { method: 'GET', headers: { accept: 'application/json' } });
  } catch (e) {
    throw new Error(`Hume token endpoint unreachable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Hume token endpoint returned ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('Hume token endpoint returned a non-JSON response');
  }

  const token = extractToken(body);
  if (!token) throw new Error('Hume token endpoint response had no access token');
  return token;
}

function extractToken(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  for (const key of ['accessToken', 'access_token', 'token']) {
    const v = b[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}
