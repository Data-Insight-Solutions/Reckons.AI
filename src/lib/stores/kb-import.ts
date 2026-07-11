/**
 * Backend-agnostic KB import/reconcile.
 *
 * Turns a graph's TTL (+ binary sidecar assets) into a KB in IndexedDB, either
 * as a fresh KB or by replacing an existing one in place. Shared by every sync
 * backend — the local File System Access folder (workspace.svelte.ts) and the
 * Google Drive folder (drive-sync.svelte.ts) — so they reconcile identically
 * and only differ in how they read/write files.
 */
import { db, KBaseDB, DEFAULT_SETTINGS } from '../storage/db';

export type KbImportMeta = { name: string; stableId?: string };
export type KbImportData = { ttl: string; assets: Map<string, Uint8Array> };

/**
 * Parse TTL + assets into `target`, REPLACING any existing statements/sources.
 * Used both for a fresh KB (empty target) and to update one whose file changed.
 * Returns the number of statements written (0 for an empty/unparseable graph).
 */
export async function populateKbFromTtl(
  target: KBaseDB,
  name: string,
  sourceUri: string,
  ttl: string,
  assets: Map<string, Uint8Array>
): Promise<number> {
  const { importTurtleFull } = await import('../rdf/import-ttl');
  const { v4: uuid } = await import('uuid');

  const { statements: rawStmts } = await importTurtleFull(ttl);
  if (rawStmts.length === 0) return 0;

  const now = Date.now();
  const sourceId = uuid();

  // The file is authoritative on (re)import — clear prior data before repopulating.
  await target.statements.clear();
  await target.sources.clear();
  await target.sources.put({
    id: sourceId,
    title: name,
    uri: sourceUri,
    kind: 'document' as const,
    trustLevel: 'trusted' as const,
    ingestedAt: now,
  });

  const stmts = rawStmts
    .filter((s) => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending')
    .map((s) => ({
      ...s,
      id: uuid(),
      sourceId,
      g: { kind: 'iri' as const, value: `urn:kbase:source/${sourceId}` },
      status: 'confirmed' as const,
      createdAt: now,
      updatedAt: now,
    }));
  await target.statements.bulkPut(stmts);

  // Import binary assets into the per-entity override tables.
  if (assets.size > 0) {
    const { parseAssetRefs, isAssetPath, extToMime } = await import('../storage/kb-assets');
    for (const ref of parseAssetRefs(ttl)) {
      if (!isAssetPath(ref.value)) continue;
      const bytes = assets.get(ref.value);
      if (!bytes) continue;
      if (ref.category === 'previews') {
        const filename = ref.value.split('/').pop() ?? 'preview';
        await target.entityGifs.put({
          id: ref.entityIri,
          blob: new Blob([bytes.buffer as ArrayBuffer], { type: extToMime(ref.value) }),
          filename,
        });
      } else if (ref.category === 'models') {
        const b64 = btoa(String.fromCharCode(...bytes));
        await target.glbOverrides.put({ id: ref.entityIri, url: `data:model/gltf-binary;base64,${b64}` });
      } else if (ref.category === 'icons') {
        const b64 = btoa(String.fromCharCode(...bytes));
        await target.icon2dOverrides.put({ id: ref.entityIri, url: `data:${extToMime(ref.value)};base64,${b64}` });
      }
    }
  }

  return stmts.length;
}

/** Create a brand-new KB from graph data. Returns the new KB id + statement count. */
export async function ingestNewKb(
  data: KbImportData,
  meta: KbImportMeta,
  sourceUri: string
): Promise<{ kbId: string; count: number } | null> {
  if (!data.ttl) return null;
  const { createKb, registerStableId } = await import('../storage/kb-registry');
  const newKb = createKb(meta.name);
  const tempDb = new KBaseDB(newKb.id);
  try {
    await tempDb.open();
    await tempDb.settings.put({ ...DEFAULT_SETTINGS, kbTitle: meta.name });
    const count = await populateKbFromTtl(tempDb, meta.name, sourceUri, data.ttl, data.assets);
    if (meta.stableId) {
      await tempDb.settings.update('main', { kbStableId: meta.stableId });
      registerStableId(newKb.id, meta.stableId, count);
    }
    return { kbId: newKb.id, count };
  } finally {
    if (tempDb !== db) tempDb.close();
  }
}

/** Replace an existing KB's data in place. Returns the statement count. */
export async function ingestExistingKb(
  kbId: string,
  data: KbImportData,
  meta: KbImportMeta,
  sourceUri: string
): Promise<number> {
  if (!data.ttl) return 0;
  const target = kbId === db.name ? db : new KBaseDB(kbId);
  try {
    if (target !== db) await target.open();
    return await populateKbFromTtl(target, meta.name, sourceUri, data.ttl, data.assets);
  } finally {
    if (target !== db) target.close();
  }
}
