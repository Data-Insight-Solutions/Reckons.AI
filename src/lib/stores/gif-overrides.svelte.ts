/**
 * Per-entity GIF preview overrides.
 *
 * Maps entity IRI → object URL (created from stored Blob).
 * GIFs are exported as RDF triples in the .ttl and bundled into kb-export.zip.
 * Object URLs are created on load and revoked on clear to avoid memory leaks.
 */
import { db } from '../storage/db';

let overrides = $state(new Map<string, string>()); // IRI → objectURL

/** Reactive getter — returns the current IRI → object URL map. */
export function gifOverrides(): Map<string, string> {
  return overrides;
}

/** Load all GIF overrides from IndexedDB, creating object URLs from stored Blobs. */
export async function loadGifOverrides(): Promise<void> {
  for (const url of overrides.values()) URL.revokeObjectURL(url);
  const rows = await db.entityGifs.toArray();
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.id, URL.createObjectURL(row.blob));
  }
  overrides = map;
}

/** Persist a GIF for the given entity IRI. Blob is stored in IndexedDB. */
export async function setGif(iri: string, blob: Blob, filename: string): Promise<void> {
  await db.entityGifs.put({ id: iri, blob, filename });
  const old = overrides.get(iri);
  if (old) URL.revokeObjectURL(old);
  overrides = new Map(overrides).set(iri, URL.createObjectURL(blob));
}

/** Remove the GIF for the given entity IRI and revoke its object URL. */
export async function clearGif(iri: string): Promise<void> {
  await db.entityGifs.delete(iri);
  const old = overrides.get(iri);
  if (old) URL.revokeObjectURL(old);
  const next = new Map(overrides);
  next.delete(iri);
  overrides = next;
}

/** Return the stored filename for a given IRI (for zip packaging). */
export async function getGifFilename(iri: string): Promise<string | null> {
  const row = await db.entityGifs.get(iri);
  return row?.filename ?? null;
}
