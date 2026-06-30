/**
 * Local Workspace — a user-selected directory on their filesystem.
 *
 * When a workspace is set it serves as:
 *  - Persistent home for all KBs with human-readable TTL and structured binary assets
 *  - Default export location for MCP server (knowledge.ttl — backward compat)
 *  - Profile sync location (settings_profile.json)
 *  - Future: model storage, cross-device sync
 *
 * KB folder layout:
 *
 *   kbs/my-kb/
 *     kb.ttl              human-readable Turtle (no base64 blobs)
 *     meta.json            discovery metadata, readOnly flag, stableId
 *     assets/              only created when the KB has binary assets
 *       icons/             2D node icons (SVG, PNG) — only if populated
 *       previews/          hover preview images (GIF, PNG, JPG) — only if populated
 *       models/            3D node models (GLB) — only if populated
 *
 * The FileSystemDirectoryHandle is stored in IndexedDB (structured-clone safe),
 * but PERMISSION must be re-granted each browser session.  We store the folder
 * name separately in SettingsRecord so the UI can show "reconnect <name>" even
 * before permission is granted.
 *
 * Requires the File System Access API — Chrome/Edge only (not Firefox/Safari).
 */
import { db, KBaseDB } from '../storage/db';
import { updateSettings } from './settings.svelte';
import { getRegistry, type KbEntry } from '../storage/kb-registry';
import { collectAssets, assetTriples, type CollectedAsset, type AssetCategory } from '../storage/kb-assets';

/** Filename written to the workspace dir on every KB mutation (read by the MCP server). */
export const WORKSPACE_KB_FILE = 'knowledge.ttl';

let _handle = $state<FileSystemDirectoryHandle | null>(null);
let _name   = $state<string | null>(null);
let _state  = $state<'none' | 'disconnected' | 'connected'>('none');
let _lastSyncTime = $state<number | null>(null);
let _syncedKbCount = $state(0);

export function workspaceHandle(): FileSystemDirectoryHandle | null { return _handle; }
export function workspaceName(): string | null { return _name; }
export function workspaceState(): 'none' | 'disconnected' | 'connected' { return _state; }
export function lastSyncTime(): number | null { return _lastSyncTime; }
export function syncedKbCount(): number { return _syncedKbCount; }

export function supportsWorkspace(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Called on app startup — loads the stored handle and checks current permission. */
export async function loadWorkspace(): Promise<void> {
  const row = await db.workspace.get('main');
  if (!row) { _state = 'none'; return; }
  _name = row.name;
  try {
    const perm = await (row.handle as any).queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      _handle = row.handle;
      _state = 'connected';
    } else {
      _state = 'disconnected';
    }
  } catch {
    _state = 'disconnected';
  }
}

/** Ask the user to pick a directory. Returns true on success. */
export async function pickWorkspace(): Promise<boolean> {
  if (!supportsWorkspace()) return false;
  try {
    const handle = await (window as unknown as { showDirectoryPicker(o?: { mode?: string }): Promise<FileSystemDirectoryHandle> })
      .showDirectoryPicker({ mode: 'readwrite' });
    await db.workspace.put({ id: 'main', handle, name: handle.name });
    _handle = handle;
    _name = handle.name;
    _state = 'connected';
    await updateSettings({ workspaceName: handle.name });
    return true;
  } catch {
    return false;
  }
}

/** Re-request permission for the stored handle (call once per session if state === 'disconnected'). */
export async function reconnectWorkspace(): Promise<boolean> {
  const row = await db.workspace.get('main');
  if (!row) return false;
  try {
    const perm = await (row.handle as any).requestPermission({ mode: 'readwrite' });
    if (perm === 'granted') {
      _handle = row.handle;
      _name = row.name;
      _state = 'connected';
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Remove the workspace from storage and memory. */
export async function clearWorkspace(): Promise<void> {
  await db.workspace.delete('main');
  _handle = null;
  _name = null;
  _state = 'none';
  _lastSyncTime = null;
  _syncedKbCount = 0;
  await updateSettings({ workspaceName: undefined });
}

// ── Low-level file helpers ───────────────────────────────────────────────────

/** Get or create a subdirectory. */
async function getOrCreateDir(parent: FileSystemDirectoryHandle, name: string): Promise<FileSystemDirectoryHandle> {
  return parent.getDirectoryHandle(name, { create: true });
}

/**
 * Read a file from the workspace directory.
 * Returns null if no workspace is connected or the file doesn't exist.
 */
export async function readFromWorkspace(filename: string): Promise<string | null> {
  if (!_handle) return null;
  try {
    const fh = await _handle.getFileHandle(filename);
    const file = await fh.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

/**
 * Write a text file to the workspace directory.
 * Silently no-ops if no workspace is connected.
 */
export async function writeToWorkspace(filename: string, content: string): Promise<void> {
  if (!_handle) return;
  try {
    const fh = await _handle.getFileHandle(filename, { create: true });
    const w = await fh.createWritable();
    await w.write(content);
    await w.close();
  } catch (e) {
    console.warn('workspace write failed:', e);
  }
}

/** Write a text file into a subdirectory handle. */
async function writeToDir(dir: FileSystemDirectoryHandle, filename: string, content: string): Promise<void> {
  const fh = await dir.getFileHandle(filename, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
}

/** Read a text file from a subdirectory handle. Returns null if not found. */
async function readFromDir(dir: FileSystemDirectoryHandle, filename: string): Promise<string | null> {
  try {
    const fh = await dir.getFileHandle(filename);
    const file = await fh.getFile();
    return await file.text();
  } catch {
    return null;
  }
}

// ── Multi-KB folder sync ─────────────────────────────────────────────────────

/** Sanitize a KB name into a safe folder name. */
function kbFolderName(name: string, id: string): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return sanitized || id;
}

export type KbMeta = {
  stableId?: string;
  name: string;
  description?: string;
  color?: string;
  createdAt: number;
  lastModified: number;
  statementCount: number;
  /** @deprecated No longer written. Kept for backward compat with existing meta.json files. */
  sourceCount?: number;
  dbName: string;
  /** When true, the app will never overwrite kb.ttl in this folder (source-of-truth is external). */
  readOnly?: boolean;
};

/**
 * Write one KB's data to the workspace folder: kbs/{folderName}/kb.ttl + meta.json
 * Binary assets written to assets/{icons,previews,models}/ — directories only created when populated.
 * Skips folders marked as readOnly in their meta.json (source-of-truth is external, e.g. symlinks).
 */
export async function writeKbToFolder(
  entry: KbEntry,
  ttl: string,
  stableId?: string,
  assets?: CollectedAsset[]
): Promise<void> {
  if (!_handle) return;
  try {
    const kbsDir = await getOrCreateDir(_handle, 'kbs');
    const folderName = kbFolderName(entry.name, entry.id);
    const kbDir = await getOrCreateDir(kbsDir, folderName);

    // Check if this folder is marked read-only — skip writing kb.ttl
    const existingMeta = await readFromDir(kbDir, 'meta.json');
    if (existingMeta) {
      try {
        const parsed = JSON.parse(existingMeta) as KbMeta;
        if (parsed.readOnly) {
          console.info(`[workspace] Skipping write for read-only KB "${entry.name}"`);
          return;
        }
      } catch { /* malformed meta, proceed with write */ }
    }

    const meta: KbMeta = {
      stableId: stableId || entry.stableId,
      name: entry.name,
      description: entry.description,
      color: entry.color,
      createdAt: entry.createdAt,
      lastModified: Date.now(),
      statementCount: entry.statementCount ?? 0,
      dbName: entry.id,
    };

    await Promise.all([
      writeToDir(kbDir, 'kb.ttl', ttl),
      writeToDir(kbDir, 'meta.json', JSON.stringify(meta, null, 2)),
    ]);

    // Write binary assets to structured directories (only populated categories)
    if (assets && assets.length > 0) {
      await writeAssetsToFolder(kbDir, assets);
    }
  } catch (e) {
    console.warn(`[workspace] KB folder write failed for "${entry.name}":`, e);
  }
}

/** Write binary assets to assets/{category}/ subdirectories. */
async function writeAssetsToFolder(
  kbDir: FileSystemDirectoryHandle,
  assets: CollectedAsset[]
): Promise<void> {
  // Group by category — only create directories that have content
  const byCategory = new Map<AssetCategory, CollectedAsset[]>();
  for (const a of assets) {
    const list = byCategory.get(a.category) ?? [];
    list.push(a);
    byCategory.set(a.category, list);
  }

  const assetsDir = await getOrCreateDir(kbDir, 'assets');

  for (const [category, entries] of byCategory) {
    const catDir = await getOrCreateDir(assetsDir, category);
    for (const entry of entries) {
      const fh = await catDir.getFileHandle(entry.filename, { create: true });
      const w = await fh.createWritable();
      await w.write(entry.data.buffer as ArrayBuffer);
      await w.close();
    }
  }
}

/**
 * Scan the kbs/ directory for KB folders (those containing meta.json).
 * Returns the parsed meta for each found KB.
 */
export async function listKbFolders(): Promise<Array<{ folderName: string; meta: KbMeta }>> {
  if (!_handle) return [];
  try {
    const kbsDir = await _handle.getDirectoryHandle('kbs');
    const results: Array<{ folderName: string; meta: KbMeta }> = [];

    for await (const entry of (kbsDir as any).values()) {
      if (entry.kind !== 'directory') continue;
      const metaText = await readFromDir(entry, 'meta.json');
      if (!metaText) continue;
      try {
        const meta = JSON.parse(metaText) as KbMeta;
        results.push({ folderName: entry.name, meta });
      } catch { /* skip malformed */ }
    }

    return results;
  } catch {
    return []; // kbs/ dir doesn't exist yet
  }
}

/**
 * Read a KB's full data from its folder.
 * Returns null if the folder or key files don't exist.
 * Also reads any binary assets from assets/{icons,previews,models}/ subdirectories.
 */
export async function readKbFromFolder(folderName: string): Promise<{
  ttl: string;
  meta: KbMeta;
  assets: Map<string, Uint8Array>; // relative path ("assets/icons/foo.svg") → bytes
} | null> {
  if (!_handle) return null;
  try {
    const kbsDir = await _handle.getDirectoryHandle('kbs');
    const kbDir = await kbsDir.getDirectoryHandle(folderName);

    const [ttl, metaText] = await Promise.all([
      readFromDir(kbDir, 'kb.ttl'),
      readFromDir(kbDir, 'meta.json'),
    ]);

    if (!ttl || !metaText) return null;
    const meta = JSON.parse(metaText) as KbMeta;

    // Read binary assets from structured directories
    const assets = new Map<string, Uint8Array>();
    try {
      const assetsDir = await kbDir.getDirectoryHandle('assets');
      for (const category of ['icons', 'previews', 'models'] as const) {
        try {
          const catDir = await assetsDir.getDirectoryHandle(category);
          for await (const entry of (catDir as any).values()) {
            if (entry.kind !== 'file') continue;
            const file = await entry.getFile();
            const ab = await file.arrayBuffer();
            assets.set(`assets/${category}/${entry.name}`, new Uint8Array(ab));
          }
        } catch { /* category dir doesn't exist — fine */ }
      }
    } catch { /* no assets/ dir — fine */ }

    return { ttl, meta, assets };
  } catch {
    return null;
  }
}

/**
 * Sync all registered KBs to the workspace folder.
 * Exports each KB's TTL + meta + assets to kbs/{name}/.
 */
export async function syncAllKbs(): Promise<number> {
  if (!_handle) return 0;
  const { toTurtle } = await import('../rdf/serialize');
  const registry = getRegistry();
  let synced = 0;

  for (const entry of registry) {
    try {
      // Open a temporary DB connection for this KB
      const kbDb = new KBaseDB(entry.id);
      const statements = await kbDb.statements.toArray();
      const settings = await kbDb.settings.get('main');
      const stableId = settings?.kbStableId;

      if (statements.length === 0 && entry.id !== 'kbase') {
        // Skip empty non-default KBs
        if (kbDb !== db) kbDb.close();
        continue;
      }

      // Collect binary assets and generate TTL with asset references
      const assets = await collectAssets(kbDb);
      const assetTtl = await assetTriples(kbDb, assets);
      const ttl = toTurtle(statements) + assetTtl;

      await writeKbToFolder(entry, ttl, stableId, assets);
      synced++;

      // Close if it's not the active DB
      if (kbDb !== db) kbDb.close();
    } catch (e) {
      console.warn(`[workspace] Failed to sync KB "${entry.name}":`, e);
    }
  }

  // Also write legacy knowledge.ttl for MCP server backward compat
  try {
    const statements = await db.statements.toArray();
    const ttl = toTurtle(statements);
    await writeToWorkspace(WORKSPACE_KB_FILE, ttl);
  } catch { /* best-effort */ }

  _syncedKbCount = synced;
  _lastSyncTime = Date.now();
  return synced;
}

// ── Workspace TTL auto-export ─────────────────────────────────────────────────
//
// After each KB mutation, schedule a debounced export to:
//  1. kbs/{name}/ folder (multi-KB sync)
//  2. knowledge.ttl (legacy MCP compat)

let _wsExportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a workspace export after a KB mutation.
 * Debounced 2 s so rapid bulk operations produce one write.
 * No-ops when no workspace is connected.
 */
export function scheduleWorkspaceTtlExport(): void {
  if (!_handle) return;
  if (_wsExportTimer) clearTimeout(_wsExportTimer);
  _wsExportTimer = setTimeout(() => {
    _wsExportTimer = null;
    _triggerWorkspaceTtlExport();
  }, 2000);
}

async function _triggerWorkspaceTtlExport(): Promise<void> {
  if (!_handle) return;
  try {
    const { toTurtle } = await import('../rdf/serialize');
    const statements = await db.statements.toArray();
    const settings = await db.settings.get('main');
    const baseTtl = toTurtle(statements);

    // Write legacy flat file for MCP server
    await writeToWorkspace(WORKSPACE_KB_FILE, baseTtl);

    // Write to multi-KB folder structure with assets
    const { getCurrentKbId } = await import('../storage/kb-registry');
    const currentId = getCurrentKbId();
    const registry = getRegistry();
    const entry = registry.find(e => e.id === currentId);
    if (entry) {
      const assets = await collectAssets(db);
      const assetTtl = await assetTriples(db, assets);
      await writeKbToFolder(entry, baseTtl + assetTtl, settings?.kbStableId, assets);
      _lastSyncTime = Date.now();
    }
  } catch (err) {
    console.warn('[workspace] TTL export failed:', err);
  }
}

// ── Pending triples from MCP server ──────────────────────────────────────────
//
// The MCP server's kb_add_note tool writes entries to knowledge.pending.jsonl
// next to knowledge.ttl. On app load (or manual trigger) we read this file,
// add the triples as pending statements for human review, then clear the file.

export const WORKSPACE_PENDING_FILE = 'knowledge.pending.jsonl';

type PendingEntry = {
  subject: string;
  predicate: string;
  object: string;
  note?: string;
  addedByMcp?: boolean;
  addedAt?: string;
  type?: 'observation' | 'question' | 'suggestion' | 'status-update' | 'drift-warning';
  commitSha?: string;
  agent?: string;
  priority?: 'low' | 'normal' | 'high';
};

/**
 * Read knowledge.pending.jsonl from the workspace, convert each line to a
 * pending Statement, and return them. Clears the file after reading.
 * Returns an empty array if the file doesn't exist or no workspace is connected.
 */
export async function drainWorkspacePending(): Promise<PendingEntry[]> {
  const text = await readFromWorkspace(WORKSPACE_PENDING_FILE);
  if (!text?.trim()) return [];

  const entries: PendingEntry[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as PendingEntry);
    } catch {
      // skip malformed lines
    }
  }

  // Clear the file so we don't re-import on next load
  if (entries.length > 0) {
    await writeToWorkspace(WORKSPACE_PENDING_FILE, '');
  }

  return entries;
}

/**
 * Drain pending.jsonl and import entries as pending statements into IndexedDB.
 * Returns the number of statements imported (0 if none or workspace not connected).
 */
export async function drainAndImportPending(): Promise<number> {
  const pending = await drainWorkspacePending();
  if (pending.length === 0) return 0;

  const { addStatements, addSource } = await import('./kb.svelte');
  const { v4: uuid } = await import('uuid');

  const sourceId = `mcp-pending-${Date.now()}`;
  const now = Date.now();

  const agents = [...new Set(pending.map(e => e.agent).filter(Boolean))];
  const agentSuffix = agents.length > 0 ? ` (${agents.join(', ')})` : '';
  await addSource({
    id: sourceId,
    title: `MCP${agentSuffix} — ${pending.length} queued note${pending.length > 1 ? 's' : ''}`,
    uri: `urn:mcp:pending:${sourceId}`,
    kind: 'analysis',
    trustLevel: 'review',
    ingestedAt: now,
  });

  const priorityToConfidence: Record<string, number> = { high: 0.9, normal: 0.7, low: 0.5 };
  const typePrefix: Record<string, string> = {
    'drift-warning': '[DRIFT WARNING] ',
    'question': '[QUESTION] ',
    'suggestion': '[SUGGESTION] ',
    'status-update': '[STATUS] ',
  };

  const sts = pending.map(e => {
    const confidence = priorityToConfidence[e.priority ?? 'normal'] ?? 0.7;
    const prefix = e.type ? (typePrefix[e.type] ?? '') : '';
    const gloss = prefix + (e.note ?? '');
    const excerpt = e.commitSha ? `commit: ${e.commitSha}` : undefined;

    return {
      id: uuid(),
      sourceId,
      status: 'pending' as const,
      confidence,
      s: { kind: 'iri' as const, value: e.subject },
      p: { kind: 'iri' as const, value: e.predicate },
      o: { kind: 'literal' as const, value: e.object },
      g: { kind: 'iri' as const, value: `urn:mcp:pending:${sourceId}` },
      ...(gloss ? { gloss } : {}),
      ...(excerpt ? { excerpt } : {}),
      createdAt: e.addedAt ? new Date(e.addedAt).getTime() : now,
      updatedAt: now,
    };
  });
  await addStatements(sts, sourceId);
  return sts.length;
}

// ── Import KBs from workspace ────────────────────────────────────────────────

/**
 * Import KBs found in the workspace folder that don't exist in IndexedDB.
 * Reads each kbs/{name}/kb.ttl, parses it, creates a Dexie DB, and registers
 * the KB. Returns the number of KBs imported.
 */
export async function importKbsFromWorkspace(): Promise<{ imported: string[]; skipped: string[] }> {
  const folders = await listKbFolders();
  if (folders.length === 0) return { imported: [], skipped: [] };

  const { importTurtleFull } = await import('../rdf/import-ttl');
  const { createKb, registerStableId, getRegistry, findKbByStableId } = await import('../storage/kb-registry');
  const { v4: uuid } = await import('uuid');
  const { DEFAULT_SETTINGS } = await import('../storage/db');

  const registry = getRegistry();
  const existing = new Set(registry.map(e => e.name.toLowerCase()));
  // Also check by stableId
  const existingStableIds = new Set<string>();
  for (const e of registry) {
    if (e.stableId) existingStableIds.add(e.stableId);
  }

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const { folderName, meta } of folders) {
    // Skip if a KB with the same name or stableId already exists
    if (existing.has(meta.name.toLowerCase()) || existing.has(folderName.toLowerCase())) {
      skipped.push(meta.name);
      continue;
    }
    if (meta.stableId && (existingStableIds.has(meta.stableId) || findKbByStableId(meta.stableId))) {
      skipped.push(meta.name);
      continue;
    }

    // Read the TTL file
    const data = await readKbFromFolder(folderName);
    if (!data?.ttl) {
      skipped.push(meta.name);
      continue;
    }

    try {
      const { statements: rawStmts } = await importTurtleFull(data.ttl);
      if (rawStmts.length === 0) {
        skipped.push(`${meta.name} (empty)`);
        continue;
      }

      // Create the KB
      const newKb = createKb(meta.name);

      // Open a temporary Dexie instance
      const tempDb = new KBaseDB(newKb.id);
      await tempDb.open();
      await tempDb.settings.put({ ...DEFAULT_SETTINGS, kbTitle: meta.name });

      const now = Date.now();
      const sourceId = uuid();
      await tempDb.sources.put({
        id: sourceId,
        title: meta.name,
        uri: `workspace://${folderName}/kb.ttl`,
        kind: 'document' as const,
        trustLevel: 'trusted' as const,
        ingestedAt: now,
      });

      const stmts = rawStmts
        .filter(s => s.status === 'confirmed' || s.status === 'refined' || s.status === 'pending')
        .map(s => ({
          ...s,
          id: uuid(),
          sourceId,
          g: { kind: 'iri' as const, value: `urn:kbase:source/${sourceId}` },
          status: 'confirmed' as const,
          createdAt: now,
          updatedAt: now,
        }));
      await tempDb.statements.bulkPut(stmts);

      // Import binary assets into IndexedDB override tables
      if (data.assets.size > 0) {
        const { parseAssetRefs, isAssetPath, extToMime } = await import('../storage/kb-assets');
        const refs = parseAssetRefs(data.ttl);
        for (const ref of refs) {
          if (!isAssetPath(ref.value)) continue;
          const bytes = data.assets.get(ref.value);
          if (!bytes) continue;

          if (ref.category === 'previews') {
            const filename = ref.value.split('/').pop() ?? 'preview';
            const mime = extToMime(ref.value);
            await tempDb.entityGifs.put({
              id: ref.entityIri,
              blob: new Blob([bytes.buffer as ArrayBuffer], { type: mime }),
              filename,
            });
          } else if (ref.category === 'models') {
            // Convert to data URL for glbOverrides
            const b64 = btoa(String.fromCharCode(...bytes));
            await tempDb.glbOverrides.put({ id: ref.entityIri, url: `data:model/gltf-binary;base64,${b64}` });
          } else if (ref.category === 'icons') {
            const mime = extToMime(ref.value);
            const b64 = btoa(String.fromCharCode(...bytes));
            await tempDb.icon2dOverrides.put({ id: ref.entityIri, url: `data:${mime};base64,${b64}` });
          }
        }
      }

      // Register stable ID
      if (meta.stableId) {
        await tempDb.settings.update('main', { kbStableId: meta.stableId });
        registerStableId(newKb.id, meta.stableId, stmts.length);
      }

      tempDb.close();
      imported.push(`${meta.name} (${stmts.length} statements)`);
    } catch (err) {
      console.warn(`[workspace] Failed to import ${meta.name}:`, err);
      skipped.push(`${meta.name} (parse error)`);
    }
  }

  return { imported, skipped };
}

// ── Model folder persistence ────────────────────────────────────────────────
//
// Models downloaded to the browser Cache API can also be saved to
// models/{repo-folder}/ in the workspace. When the cache is cleared,
// the app can restore from the workspace folder instead of re-downloading.

/**
 * Sanitize a HuggingFace repo ID into a safe folder name.
 * e.g. "onnx-community/Qwen2.5-0.5B-Instruct" → "onnx-community--Qwen2.5-0.5B-Instruct"
 */
function modelFolderName(repo: string): string {
  return repo.replace(/\//g, '--');
}

/**
 * Write a single model file to the workspace models/ directory.
 * Path is relative to the model repo (e.g. "onnx/model_q4.onnx").
 */
export async function writeModelFile(
  repo: string,
  filePath: string,
  data: ArrayBuffer
): Promise<void> {
  if (!_handle) return;
  try {
    const modelsDir = await getOrCreateDir(_handle, 'models');
    const repoDir = await getOrCreateDir(modelsDir, modelFolderName(repo));

    // Handle nested paths like "onnx/model_q4.onnx" or "voices/af_heart.bin"
    const segments = filePath.split('/');
    let dir = repoDir;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await getOrCreateDir(dir, segments[i]);
    }

    const fileName = segments[segments.length - 1];
    const fh = await dir.getFileHandle(fileName, { create: true });
    const w = await fh.createWritable();
    await w.write(data);
    await w.close();
  } catch (e) {
    console.warn(`[workspace] Model file write failed for "${repo}/${filePath}":`, e);
  }
}

/**
 * Read a single model file from the workspace models/ directory.
 * Returns null if not found or no workspace connected.
 */
export async function readModelFile(
  repo: string,
  filePath: string
): Promise<ArrayBuffer | null> {
  if (!_handle) return null;
  try {
    const modelsDir = await _handle.getDirectoryHandle('models');
    const repoDir = await modelsDir.getDirectoryHandle(modelFolderName(repo));

    const segments = filePath.split('/');
    let dir: FileSystemDirectoryHandle = repoDir;
    for (let i = 0; i < segments.length - 1; i++) {
      dir = await dir.getDirectoryHandle(segments[i]);
    }

    const fileName = segments[segments.length - 1];
    const fh = await dir.getFileHandle(fileName);
    const file = await fh.getFile();
    return await file.arrayBuffer();
  } catch {
    return null;
  }
}

/**
 * Check which model files exist in the workspace models/ directory.
 * Returns an array of file paths that are present.
 */
export async function listModelFiles(repo: string, filePaths: string[]): Promise<string[]> {
  if (!_handle) return [];
  try {
    const modelsDir = await _handle.getDirectoryHandle('models');
    const repoDir = await modelsDir.getDirectoryHandle(modelFolderName(repo));

    const found: string[] = [];
    for (const fp of filePaths) {
      try {
        const segments = fp.split('/');
        let dir: FileSystemDirectoryHandle = repoDir;
        for (let i = 0; i < segments.length - 1; i++) {
          dir = await dir.getDirectoryHandle(segments[i]);
        }
        await dir.getFileHandle(segments[segments.length - 1]);
        found.push(fp);
      } catch {
        // file doesn't exist
      }
    }
    return found;
  } catch {
    return []; // models/ or repo dir doesn't exist
  }
}
