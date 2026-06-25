/**
 * KB identity utilities — two complementary identifiers per knowledge base:
 *
 *  1. Stable KB ID — a UUID created once when the KB is first used and stored
 *     in settings. Never changes, even as content evolves. Used for MCP routing,
 *     cloud sync folder naming, and cross-device references.
 *
 *  2. Content fingerprint — SHA-256 of the sorted canonical N-Quad triples of
 *     all confirmed/refined statements. Changes with every edit. Used for sync
 *     verification, deduplication, and snapshot references.
 *
 * Neither requires a server or account — both are derived purely locally.
 */

import { v4 as uuid } from 'uuid';
import { termToString } from '../rdf/types';
import type { Statement } from '../rdf/types';

// ── Stable KB ID ──────────────────────────────────────────────────────────────

/**
 * Return the stable KB ID from settings, generating and persisting one if it
 * doesn't exist yet. Call after settings are loaded.
 */
export async function getOrCreateStableId(
  currentId: string | undefined,
  persist: (id: string) => Promise<void>
): Promise<string> {
  if (currentId) return currentId;
  const id = uuid();
  await persist(id);
  return id;
}

/**
 * Format a stable KB ID for display — first 8 chars of the UUID, uppercase.
 * e.g. "a1b2c3d4-..." → "A1B2C3D4"
 */
export function formatStableId(id: string): string {
  return id.split('-')[0].toUpperCase();
}

// ── Content fingerprint ───────────────────────────────────────────────────────

/**
 * Compute a SHA-256 fingerprint of the KB's confirmed content.
 *
 * Algorithm:
 *   1. Filter to confirmed + refined statements, excluding meta-predicates.
 *   2. Serialize each as a canonical N-Quad string (s p o g).
 *   3. Sort lines lexicographically — order-independent.
 *   4. SHA-256 hash the UTF-8 bytes.
 *   5. Return first 32 hex chars (128 bits — sufficient for practical uniqueness).
 */
export async function computeContentHash(statements: Statement[]): Promise<string> {
  const lines = statements
    .filter(
      (s) =>
        (s.status === 'confirmed' || s.status === 'refined') &&
        s.p.value !== 'urn:kbase:meta/suggests-merge'
    )
    .map(
      (s) =>
        `${termToString(s.s)} ${termToString(s.p)} ${termToString(s.o)} ${termToString(s.g)} .`
    )
    .sort();

  const canonical = lines.join('\n');
  const bytes = new TextEncoder().encode(canonical);

  // crypto.subtle is unavailable in insecure contexts (HTTP, some mobile browsers).
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return fnv1aFallback(bytes).slice(0, 32);
  }
  try {
    const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(hashBuf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return hex.slice(0, 32);
  } catch {
    return fnv1aFallback(bytes).slice(0, 32);
  }
}

/** FNV-1a 128-bit fallback when crypto.subtle is unavailable. */
function fnv1aFallback(data: Uint8Array): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0xc4ceb9fe >>> 0;
  for (let i = 0; i < data.length; i++) {
    h1 ^= data[i]; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= data[i]; h2 = Math.imul(h2, 0x01000193) >>> 0;
    h2 ^= (h1 >>> 16);
  }
  return (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
}

/**
 * Format a content hash for compact display — 4-char groups separated by dashes.
 * e.g. "a1b2c3d4e5f6..." → "a1b2-c3d4-e5f6-7890"
 */
export function formatContentHash(hash: string): string {
  return hash.match(/.{1,4}/g)?.slice(0, 4).join('-') ?? hash;
}
