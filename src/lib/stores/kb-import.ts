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
import type { Statement, Source } from '../rdf/types';

export type KbImportMeta = { name: string; stableId?: string };
export type KbImportData = { ttl: string; assets: Map<string, Uint8Array> };

/** A per-entity asset override decoded from the sidecar bytes, ready to write. */
type DecodedAsset =
  | { kind: 'gif'; id: string; blob: Blob; filename: string }
  | { kind: 'glb'; id: string; url: string }
  | { kind: 'icon'; id: string; url: string };

/**
 * Parse TTL + assets into `target`, REPLACING its statements/sources.
 *
 * LOSSLESS + NON-DESTRUCTIVE (F107.4): a full annotated export (`toTurtleFull`) round-trips
 * with every status (pending, rejected, superseded, …) and its provenance intact; a plain
 * external/legacy TTL still imports as confirmed knowledge. Before the replace, the KB's
 * current state is captured as a recovery snapshot, and the clear+repopulate runs in one Dexie
 * transaction so a mid-write failure rolls back instead of leaving a half-cleared KB.
 *
 * Used for a fresh KB (empty target) and to update one whose file changed. Returns the number
 * of statements written (0 for an empty/unparseable graph).
 */
export async function populateKbFromTtl(
  target: KBaseDB,
  name: string,
  sourceUri: string,
  ttl: string,
  assets: Map<string, Uint8Array>,
  opts: {
    /**
     * Import a plain TTL as REVIEW WORK rather than as settled knowledge.
     *
     * A plain file carries no review state, so the default treats it as confirmed — correct for a
     * legacy or external graph you are adopting wholesale. It is wrong for a graph you want to
     * READ THROUGH: a demo, a draft, or anything arriving from someone else that you intend to
     * judge fact by fact. Measured 2026-08-21: the F139 demo graphs import 87 plain triples, so
     * arriving via workspace sync they landed confirmed and the review tree correctly showed
     * nothing — the fixtures only ever worked through /ingest, which keeps them pending.
     *
     * Ignored for an ANNOTATED file: that one already states each statement's real status, and
     * overriding it would destroy the review state the annotation exists to carry.
     */
    asPending?: boolean;
  } = {},
): Promise<number> {
  const { importTurtleFull } = await import('../rdf/import-ttl');
  const { v4: uuid } = await import('uuid');

  const { statements: rawStmts, sources: rawSources, cleanImportCount } = await importTurtleFull(ttl);
  if (rawStmts.length === 0) return 0;

  const now = Date.now();

  // Decide what to write. An annotated file (no plain-triple fallback ran) carries real review
  // state and provenance — preserve them verbatim. A plain/legacy/external file has none, so
  // keep the historical behavior of treating it as confirmed knowledge under one synthetic
  // source; trusting the fallback's `pending` default would wrongly flip legacy files to pending.
  const isAnnotated = cleanImportCount === 0;

  let outStatements: Statement[];
  let outSources: Source[];

  if (isAnnotated) {
    outSources = rawSources;
    outStatements = rawStmts;
  } else {
    const sourceId = uuid();
    outSources = [{
      id: sourceId,
      title: name,
      uri: sourceUri,
      kind: 'document',
      trustLevel: 'trusted',
      ingestedAt: now,
    }];
    outStatements = rawStmts.map((s) => ({
      ...s,
      id: uuid(),
      sourceId,
      g: { kind: 'iri' as const, value: `urn:kbase:source/${sourceId}` },
      status: (opts.asPending ? 'pending' : 'confirmed') as 'pending' | 'confirmed',
      createdAt: now,
      updatedAt: now,
    }));
  }

  // Decode binary assets OUTSIDE the transaction (btoa/Blob work is not a Dexie op).
  const decoded: DecodedAsset[] = [];
  if (assets.size > 0) {
    const { parseAssetRefs, isAssetPath, extToMime } = await import('../storage/kb-assets');
    for (const ref of parseAssetRefs(ttl)) {
      if (!isAssetPath(ref.value)) continue;
      const bytes = assets.get(ref.value);
      if (!bytes) continue;
      if (ref.category === 'previews') {
        const filename = ref.value.split('/').pop() ?? 'preview';
        decoded.push({ kind: 'gif', id: ref.entityIri, filename, blob: new Blob([bytes.buffer as ArrayBuffer], { type: extToMime(ref.value) }) });
      } else if (ref.category === 'models') {
        const b64 = btoa(String.fromCharCode(...bytes));
        decoded.push({ kind: 'glb', id: ref.entityIri, url: `data:model/gltf-binary;base64,${b64}` });
      } else if (ref.category === 'icons') {
        const b64 = btoa(String.fromCharCode(...bytes));
        decoded.push({ kind: 'icon', id: ref.entityIri, url: `data:${extToMime(ref.value)};base64,${b64}` });
      }
    }
  }

  // Build the pre-replace recovery snapshot BEFORE the transaction (serialization awaits would
  // otherwise commit the transaction early), then persist it inside the same atomic replace.
  const { buildKbSnapshot, pruneSnapshots } = await import('../storage/kb-snapshots');
  const snapshot = await buildKbSnapshot(target, `reconcile: ${sourceUri}`);

  await target.transaction(
    'rw',
    [target.statements, target.sources, target.entityGifs, target.glbOverrides, target.icon2dOverrides, target.kbSnapshots],
    async () => {
      if (snapshot) await target.kbSnapshots.put(snapshot);
      await target.statements.clear();
      await target.sources.clear();
      await target.sources.bulkPut(outSources);
      await target.statements.bulkPut(outStatements);
      for (const a of decoded) {
        if (a.kind === 'gif') await target.entityGifs.put({ id: a.id, blob: a.blob, filename: a.filename });
        else if (a.kind === 'glb') await target.glbOverrides.put({ id: a.id, url: a.url });
        else await target.icon2dOverrides.put({ id: a.id, url: a.url });
      }
    }
  );

  // Prune old snapshots after the atomic replace has committed (housekeeping, not safety-critical).
  if (snapshot) await pruneSnapshots(target, target.name).catch(() => {});

  return outStatements.length;
}

/** Create a brand-new KB from graph data. Returns the new KB id + statement count. */
export async function ingestNewKb(
  data: KbImportData,
  meta: KbImportMeta,
  sourceUri: string,
  opts: { asPending?: boolean } = {},
): Promise<{ kbId: string; count: number } | null> {
  if (!data.ttl) return null;
  const { createKb, registerStableId } = await import('../storage/kb-registry');
  const newKb = createKb(meta.name);
  const tempDb = new KBaseDB(newKb.id);
  try {
    await tempDb.open();
    await tempDb.settings.put({ ...DEFAULT_SETTINGS, kbTitle: meta.name });
    const count = await populateKbFromTtl(tempDb, meta.name, sourceUri, data.ttl, data.assets, opts);
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
  sourceUri: string,
  opts: { asPending?: boolean } = {},
): Promise<number> {
  if (!data.ttl) return 0;
  const target = kbId === db.name ? db : new KBaseDB(kbId);
  try {
    if (target !== db) await target.open();
    return await populateKbFromTtl(target, meta.name, sourceUri, data.ttl, data.assets, opts);
  } finally {
    if (target !== db) target.close();
  }
}
