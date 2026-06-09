/**
 * Per-entity 2D icon overrides (editor-level, not stored in KB).
 *
 * Maps entity IRI -> image URL (data URL from file upload, or remote/local URL).
 * These take priority over urn:kbase:predicate/icon2d KB statements in the 2D graph.
 */
import { db } from '../storage/db';

let _overrides = $state(new Map<string, string>()); // IRI -> URL

/** Reactive getter — returns current IRI -> URL map. */
export function icon2dOverrides(): Map<string, string> {
  return _overrides;
}

/** Load all icon2d overrides from IndexedDB on startup. */
export async function loadIcon2dOverrides(): Promise<void> {
  const rows = await db.icon2dOverrides.toArray();
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.id, row.url);
  }
  _overrides = map;
}

/** Store a 2D icon URL for the given entity IRI. */
export async function setIcon2d(iri: string, url: string): Promise<void> {
  await db.icon2dOverrides.put({ id: iri, url });
  _overrides = new Map(_overrides).set(iri, url);
}

/** Remove the 2D icon for the given entity IRI. */
export async function clearIcon2d(iri: string): Promise<void> {
  await db.icon2dOverrides.delete(iri);
  const next = new Map(_overrides);
  next.delete(iri);
  _overrides = next;
}
