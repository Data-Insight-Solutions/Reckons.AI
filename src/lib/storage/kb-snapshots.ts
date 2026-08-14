/**
 * Pre-replace recovery snapshots (F107.4).
 *
 * Sync reconcile replaces a KB's contents in place. Before any destructive clear, we capture
 * the KB's CURRENT state as a lossless `toTurtleFull` export (all statuses + provenance) so a
 * bad reconcile is recoverable rather than a silent loss of review history. Backend-agnostic:
 * it operates on a `KBaseDB` and so protects both the local folder and Google Drive paths.
 */
import type { KBaseDB, KbSnapshotRow } from './db';

/** How many snapshots to keep per KB — enough to recover a recent mistake, bounded storage. */
const MAX_SNAPSHOTS_PER_KB = 3;

/**
 * Serialize the current state of `target` into a snapshot row WITHOUT writing it. Returns null
 * when the KB is empty — there is nothing to lose. Kept separate from the write so a caller
 * mid-reconcile can build the snapshot before opening its Dexie transaction (dynamic imports
 * and cross-table awaits inside a transaction would commit it early), then persist the row
 * inside that same atomic replace. See `populateKbFromTtl`.
 */
export async function buildKbSnapshot(target: KBaseDB, reason: string): Promise<KbSnapshotRow | null> {
  const [statements, sources] = await Promise.all([
    target.statements.toArray(),
    target.sources.toArray(),
  ]);
  if (statements.length === 0) return null;

  const { toTurtleFull } = await import('../rdf/serialize');
  const { v4: uuid } = await import('uuid');
  const settings = await target.settings.get('main');

  return {
    id: uuid(),
    kbId: target.name,
    createdAt: Date.now(),
    reason,
    statementCount: statements.length,
    ttl: toTurtleFull(statements, sources, { kbStableId: settings?.kbStableId }),
  };
}

/**
 * Capture the current state of `target` as a recovery snapshot (build + write + prune). No-op
 * (returns null) when the KB is empty. For standalone callers; the reconcile path inlines the
 * write into its transaction via `buildKbSnapshot` + `pruneSnapshots`.
 */
export async function snapshotKbState(target: KBaseDB, reason: string): Promise<KbSnapshotRow | null> {
  const row = await buildKbSnapshot(target, reason);
  if (!row) return null;
  await target.kbSnapshots.put(row);
  await pruneSnapshots(target, target.name);
  return row;
}

/** Newest-first snapshots for a KB (defaults to the target's own id). */
export async function listKbSnapshots(target: KBaseDB, kbId?: string): Promise<KbSnapshotRow[]> {
  const id = kbId ?? target.name;
  const rows = await target.kbSnapshots.where('kbId').equals(id).toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Restore a snapshot's TTL back into `target`, replacing current contents atomically.
 * Returns the number of statements restored. Throws if the snapshot id is unknown.
 */
export async function restoreKbSnapshot(target: KBaseDB, snapshotId: string): Promise<number> {
  const row = await target.kbSnapshots.get(snapshotId);
  if (!row) throw new Error(`snapshot not found: ${snapshotId}`);

  const { populateKbFromTtl } = await import('../stores/kb-import');
  const settings = await target.settings.get('main');
  const name = settings?.kbTitle ?? target.name;
  // The snapshot is a full annotated export, so this round-trips with full fidelity.
  return populateKbFromTtl(target, name, `snapshot://${row.id}`, row.ttl, new Map());
}

export async function pruneSnapshots(target: KBaseDB, kbId: string): Promise<void> {
  const rows = await listKbSnapshots(target, kbId);
  const stale = rows.slice(MAX_SNAPSHOTS_PER_KB);
  if (stale.length > 0) await target.kbSnapshots.bulkDelete(stale.map((r) => r.id));
}
