/**
 * Recursive secret redaction (F107.5).
 *
 * A "safe to share" export is only safe if NO credential rides along — including one nested
 * inside an object the export passes through wholesale. The settings profile did exactly that:
 * it allowlisted top-level fields (so top-level API keys were excluded) but embedded
 * `turtleSettings` whole, and `turtleSettings` carries `humeApiKey` / `humeSecretKey`. So a
 * key leaked through a "no secrets" export.
 *
 * A denylist of known field names cannot keep up with new nested credentials. This is the
 * positive rule instead: any field whose NAME looks like a secret is dropped, at every depth.
 * It is deliberately conservative — better to drop a borderline field from a shareable profile
 * than to leak one.
 */

/**
 * A key names a secret when it ends in one of these (case-insensitive, ignoring separators):
 * apikey, api_key, secretkey, secret_key, secret, token, password, passwd, pwd, credential(s),
 * privatekey, private_key, accesskey, access_key, sessiontoken, bearer.
 * `configId`, `clientId`, `stableId`, `baseUrl`, `model` etc. deliberately do NOT match — they
 * are not credentials.
 */
const SECRET_KEY = /(api[-_]?key|secret[-_]?key|access[-_]?key|private[-_]?key|session[-_]?token|secret|token|password|passwd|pwd|credentials?|bearer)$/i;

/** True when a field name looks like it holds a credential. */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/[-_]/g, ''));
}

/**
 * Return a deep copy of `value` with every secret-named field removed, at any depth. Arrays are
 * walked element-wise. Non-plain values (Date, etc.) are returned as-is. The input is not mutated.
 */
export function redactSecrets<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === 'object' && isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (isSecretKey(k)) continue; // drop the credential entirely
      out[k] = walk(v);
    }
    return out;
  }
  return value;
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
