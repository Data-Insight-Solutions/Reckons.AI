/**
 * Editor-level GLB model overrides.
 *
 * Maps IRI (entity or type) → data URL or remote URL.
 * Stored in IndexedDB but never written to the KB or exported to Turtle/RDF.
 * This keeps large base64 blobs out of the knowledge graph entirely.
 */
import { db } from '../storage/db';

let _overrides = $state(new Map<string, string>());

/** Reactive getter — returns the current IRI → URL map. */
export function glbOverrides(): Map<string, string> {
  return _overrides;
}

/** Load all overrides from IndexedDB on startup. Also runs a one-time migration
 *  that moves any legacy KB_ICON3D triples out of the statement store. */
export async function loadGlbOverrides(): Promise<void> {
  const rows = await db.glbOverrides.toArray();
  _overrides = new Map(rows.map((r) => [r.id, r.url]));
  await _migrateKbIcon3d();
}

/** Move legacy `urn:kbase:predicate/icon3d` KB statements into the local store. */
async function _migrateKbIcon3d(): Promise<void> {
  const KB_ICON3D = 'urn:kbase:predicate/icon3d';
  const stmts = await db.statements
    .filter((s) => s.p.value === KB_ICON3D && s.status !== 'rejected' && s.status !== 'superseded')
    .toArray();
  if (stmts.length === 0) return;

  const now = Date.now();
  for (const stmt of stmts) {
    if (stmt.s.kind === 'iri' && stmt.o.kind === 'literal') {
      // Migrate value unless already locally overridden
      if (!_overrides.has(stmt.s.value)) {
        await db.glbOverrides.put({ id: stmt.s.value, url: stmt.o.value });
        _overrides = new Map(_overrides).set(stmt.s.value, stmt.o.value);
      }
    }
    // Reject the KB statement regardless
    await db.statements.update(stmt.id, { status: 'rejected', updatedAt: now });
  }
}

/** Persist a GLB override for the given IRI. */
export async function setGlb(iri: string, url: string): Promise<void> {
  await db.glbOverrides.put({ id: iri, url });
  _overrides = new Map(_overrides).set(iri, url);
}

/** Remove the GLB override for the given IRI. */
export async function clearGlb(iri: string): Promise<void> {
  await db.glbOverrides.delete(iri);
  const next = new Map(_overrides);
  next.delete(iri);
  _overrides = next;
}
