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
 *     my-kb.ttl            human-readable Turtle (no base64 blobs), named
 *                           after the folder. Legacy `kb.ttl` is still read
 *                           on import for backward compatibility, but is
 *                           no longer written.
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
import { getRegistry, getCurrentKbName, type KbEntry } from '../storage/kb-registry';
import { collectAssets, assetTriples, type CollectedAsset, type AssetCategory } from '../storage/kb-assets';
import { dedupeCompletePending } from '../rdf/pending-dedup';

/** Filename written to the workspace dir on every KB mutation (read by the MCP server). */
export const WORKSPACE_KB_FILE = 'knowledge.ttl';

let _handle = $state<FileSystemDirectoryHandle | null>(null);
let _name   = $state<string | null>(null);
let _state  = $state<'none' | 'disconnected' | 'connected'>('none');
let _lastSyncTime = $state<number | null>(null);
let _syncedKbCount = $state(0);

// ── Two-way sync state ───────────────────────────────────────────────────────
//
// Sync used to be one-way (app → disk). We now also PULL: poll the linked folder
// and import new `.ttl` files / update KBs whose file changed on disk. To avoid a
// write→read feedback loop, every file the app writes has its content hash
// recorded in `_seenHashes`; a poll skips any file whose hash already matches.

const AUTOSYNC_KEY = 'reckons:ws-autosync';
const POLL_INTERVAL_MS = 10_000;

/** path-key ("kbs/foo/foo.ttl") → last-seen content hash of that file. */
const _seenHashes = new Map<string, string>();
let _autoSyncEnabled = $state<boolean>(readAutoSyncPref());
let _pollTimer: ReturnType<typeof setInterval> | null = null;
let _pulling = false;

export function workspaceHandle(): FileSystemDirectoryHandle | null { return _handle; }
export function workspaceName(): string | null { return _name; }
export function workspaceState(): 'none' | 'disconnected' | 'connected' { return _state; }
export function lastSyncTime(): number | null { return _lastSyncTime; }
export function syncedKbCount(): number { return _syncedKbCount; }
export function autoSyncEnabled(): boolean { return _autoSyncEnabled; }

export function supportsWorkspace(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** FNV-1a 32-bit hash of a string → hex. Cheap change-detection for file text. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/** Record the hash of content the app itself wrote, so a poll never re-pulls it. */
function markWritten(pathKey: string, content: string): void {
  _seenHashes.set(pathKey, hashString(content));
}

function readAutoSyncPref(): boolean {
  if (typeof localStorage === 'undefined') return true; // default on
  return localStorage.getItem(AUTOSYNC_KEY) !== 'false';
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
      onWorkspaceConnected();
    } else {
      _state = 'disconnected';
    }
  } catch {
    _state = 'disconnected';
  }
}

/** Kick off auto-sync after a handle becomes connected (load/pick/reconnect).
 *  Pulls once to catch changes made on disk while the app was closed, then
 *  starts polling if auto-sync is enabled. Best-effort; never throws. */
function onWorkspaceConnected(): void {
  if (!_autoSyncEnabled) return;
  // Fire-and-forget: an initial pull followed by the polling loop.
  void pullFromWorkspace().finally(() => startWorkspacePolling());
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
    // Polling starts via handlePickWorkspace after its initial import/sync so we
    // don't race that flow; enable it here for the reconnect-less first link.
    if (_autoSyncEnabled) startWorkspacePolling();
    return true;
  } catch (e) {
    // AbortError = user cancelled, or the OS directory picker was unavailable — e.g.
    // Snap-confined Chromium without a working xdg-desktop-portal, where the picker
    // aborts instantly. Stay quiet on that; surface any other failure rather than
    // swallowing it silently (a folder link that fails with no feedback is confusing).
    if ((e as Error)?.name !== 'AbortError') console.error('[workspace] link folder failed:', e);
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
      onWorkspaceConnected();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Remove the workspace from storage and memory. */
export async function clearWorkspace(): Promise<void> {
  stopWorkspacePolling();
  _seenHashes.clear();
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

/**
 * Read a KB's TTL from a folder, preferring `{folderName}.ttl` and falling
 * back to the legacy `kb.ttl` filename when the named file isn't present.
 */
async function readKbTtl(dir: FileSystemDirectoryHandle, folderName: string): Promise<string | null> {
  const named = await readFromDir(dir, `${folderName}.ttl`);
  if (named !== null) return named;
  return readFromDir(dir, 'kb.ttl');
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
};

/**
 * Write one KB's data to the workspace folder: kbs/{folderName}/{folderName}.ttl
 * Binary assets written to assets/{icons,previews,models}/ — directories only created when populated.
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

    await writeToDir(kbDir, `${folderName}.ttl`, ttl);
    // Remember what we wrote so the poll loop doesn't treat our own write as an
    // external change and re-import it (write→read feedback loop).
    markWritten(`kbs/${folderName}/${folderName}.ttl`, ttl);

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

/** Directories the recursive `.ttl` walk never descends into. `assets/` holds
 *  binary asset stores (not KBs); the rest are dependency/VCS/build dirs that
 *  would otherwise flood discovery with stray `.ttl` fixtures when the linked
 *  folder is a real project root (e.g. a git repo). Hidden dirs (dot-prefixed:
 *  `.git`, `.svelte-kit`, `.cache`, …) are skipped separately below. */
const WALK_SKIP_DIRS = new Set(['assets', 'node_modules', 'build', 'dist', 'coverage', 'vendor']);

/** Recursively yield the path segments of every `.ttl` file under `dir`.
 *  Skips asset stores, dependency/build/VCS directories, and hidden folders, so
 *  linking a real project folder discovers the user's KBs without pulling in
 *  node_modules/.git/build `.ttl` files. */
async function* walkTtls(dir: any, prefix: string[] = []): AsyncGenerator<string[]> {
  for await (const entry of dir.values()) {
    if (entry.kind === 'directory') {
      if (WALK_SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      yield* walkTtls(entry, [...prefix, entry.name]);
    } else if (entry.kind === 'file' && entry.name.endsWith('.ttl') && entry.name !== WORKSPACE_KB_FILE) {
      // Skip the MCP combined export (knowledge.ttl) so it isn't imported as a
      // duplicate KB alongside the real per-graph files.
      yield [...prefix, entry.name];
    }
  }
}

/** Read a `.ttl` by its path segments relative to the workspace root. */
export async function readTtlByPath(segs: string[]): Promise<string | null> {
  if (!_handle) return null;
  try {
    let dir: any = _handle;
    for (const seg of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
    return await readFromDir(dir, segs[segs.length - 1]);
  } catch {
    return null;
  }
}

/**
 * Discover every KB in the workspace: ANY `.ttl` file anywhere under the linked
 * folder (recursive) — not just the `kbs/{name}/{name}.ttl` convention. A loose
 * file is named after its filename; a conventional `kbs/{name}/{name}.ttl` (or
 * legacy `kb.ttl`) is named after its folder. Legacy `kb.ttl` is dropped when a
 * named sibling exists so a KB isn't listed twice. Each entry carries the file
 * `path` so it can be read regardless of location.
 */
export async function listKbFolders(): Promise<Array<{ folderName: string; path: string[]; meta: KbMeta }>> {
  if (!_handle) return [];
  try {
    const paths: string[][] = [];
    for await (const p of walkTtls(_handle)) paths.push(p);

    // Track filenames per directory to drop legacy kb.ttl duplicates.
    const dirFiles = new Map<string, Set<string>>();
    for (const p of paths) {
      const d = p.slice(0, -1).join('/');
      (dirFiles.get(d) ?? dirFiles.set(d, new Set()).get(d)!).add(p[p.length - 1]);
    }

    const results: Array<{ folderName: string; path: string[]; meta: KbMeta }> = [];
    for (const p of paths) {
      const file = p[p.length - 1];
      const dirSegs = p.slice(0, -1);
      const dirName = dirSegs[dirSegs.length - 1] ?? '';
      if (file === 'kb.ttl' && dirFiles.get(dirSegs.join('/'))?.has(`${dirName}.ttl`)) continue;
      const conventional = dirSegs[0] === 'kbs' && (file === `${dirName}.ttl` || file === 'kb.ttl');
      const folderName = conventional ? dirName : file.replace(/\.ttl$/, '');

      const ttl = await readTtlByPath(p);
      const stableIdMatch = ttl?.match(/kbStableId[>"]\s+"([^"]+)"/);
      results.push({ folderName, path: p, meta: { name: folderName, stableId: stableIdMatch?.[1] } });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Read a KB's full data from its folder.
 * Returns null if the folder or its TTL file (`{folderName}.ttl`, or legacy
 * `kb.ttl`) don't exist.
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

    const ttl = await readKbTtl(kbDir, folderName);
    if (!ttl) return null;

    const stableIdMatch = ttl.match(/kbStableId[>"]\s+"([^"]+)"/);
    const meta: KbMeta = {
      name: folderName,
      stableId: stableIdMatch?.[1],
    };

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
  const { toTurtle, toTurtleFull } = await import('../rdf/serialize');
  const registry = getRegistry();
  let synced = 0;

  for (const entry of registry) {
    try {
      // Open a temporary DB connection for this KB
      const kbDb = new KBaseDB(entry.id);
      const statements = await kbDb.statements.toArray();
      const sources = await kbDb.sources.toArray();
      const settings = await kbDb.settings.get('main');
      const stableId = settings?.kbStableId;

      if (statements.length === 0 && entry.id !== 'kbase') {
        // Skip empty non-default KBs
        if (kbDb !== db) kbDb.close();
        continue;
      }

      // Collect binary assets and generate LOSSLESS TTL (all statuses + provenance) so the
      // per-KB folder file round-trips without dropping review state on a later re-pull.
      const assets = await collectAssets(kbDb);
      const assetTtl = await assetTriples(kbDb, assets);
      const ttl = toTurtleFull(statements, sources, { kbStableId: stableId }) + assetTtl;

      await writeKbToFolder(entry, ttl, stableId, assets);
      synced++;

      // Close if it's not the active DB
      if (kbDb !== db) kbDb.close();
    } catch (e) {
      console.warn(`[workspace] Failed to sync KB "${entry.name}":`, e);
    }
  }

  // Also write legacy knowledge.ttl for the MCP server — kept LOSSY on purpose (see export note).
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
    const { toTurtle, toTurtleFull } = await import('../rdf/serialize');
    const statements = await db.statements.toArray();
    const sources = await db.sources.toArray();
    const settings = await db.settings.get('main');

    // Legacy flat file for the MCP server stays a LOSSY confirmed/refined projection —
    // reification `stmt:` nodes would otherwise surface as spurious entities in the reader.
    await writeToWorkspace(WORKSPACE_KB_FILE, toTurtle(statements));

    // The per-KB folder file is the one that gets re-imported, so it must be LOSSLESS
    // (all statuses + provenance) or a re-pull silently drops review state (F107.4).
    const { getCurrentKbId } = await import('../storage/kb-registry');
    const currentId = getCurrentKbId();
    const registry = getRegistry();
    const entry = registry.find(e => e.id === currentId);
    if (entry) {
      const assets = await collectAssets(db);
      const assetTtl = await assetTriples(db, assets);
      const fullTtl = toTurtleFull(statements, sources, { kbStableId: settings?.kbStableId });
      await writeKbToFolder(entry, fullTtl + assetTtl, settings?.kbStableId, assets);
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
  /**
   * Target graph, by name (F80). An agent's question about kb:auto-merge belongs in the
   * Reckons.AI roadmap graph, NOT in whatever the user happened to have open.
   *
   * Omit to mean "any graph" (legacy entries, and notes that are not graph-specific).
   * Entries addressed to a DIFFERENT graph are put back in the file rather than consumed —
   * see drainWorkspacePending. Draining used to be unconditionally destructive: it read the
   * file, cleared it, and imported everything into the active graph, so a question could be
   * misfiled into the wrong graph AND lost from the file, with no way to retry.
   */
  kb?: string;
  /** Omit (or leave empty) to denote a PARTIAL FACT whose object the reviewer must fill (F32). */
  object?: string;
  /** The sub-agent's question for a partial fact (F32). */
  question?: string;
  /** Entity IRIs this unanswered question blocks (F80). Carried onto the Statement. */
  blocks?: string | string[];
  note?: string;
  addedByMcp?: boolean;
  addedAt?: string;
  type?: 'observation' | 'question' | 'suggestion' | 'status-update' | 'drift-warning';
  commitSha?: string;
  agent?: string;
  priority?: 'low' | 'normal' | 'high';
};

/**
 * Read knowledge.pending.jsonl, take the entries meant for the ACTIVE graph, and PUT THE
 * REST BACK. Returns an empty array if the file doesn't exist or no workspace is connected.
 *
 * Draining is destructive — it consumes the file — so it must only consume what it can
 * actually deliver. An entry addressed to another graph (`kb`) is left in the file for
 * that graph to claim. Previously drain took everything and imported it into whatever
 * graph happened to be open, so an agent's question about the roadmap could be silently
 * misfiled into a user's personal notes AND erased from the file, with no way to retry.
 */
export async function drainWorkspacePending(): Promise<PendingEntry[]> {
  const text = await readFromWorkspace(WORKSPACE_PENDING_FILE);
  if (!text?.trim()) return [];

  const active = getCurrentKbName();
  const entries: PendingEntry[] = [];
  const notMine: string[] = [];

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as PendingEntry;
      // No `kb` = any graph. Otherwise it must match the active one, or it waits.
      if (entry.kb && entry.kb !== active) notMine.push(trimmed);
      else entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }

  // Consume ONLY what we took. Entries addressed to another graph are written back so
  // that graph can claim them later — clearing the whole file would destroy them.
  if (entries.length > 0) {
    await writeToWorkspace(WORKSPACE_PENDING_FILE, notMine.length ? notMine.join('\n') + '\n' : '');
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
    // Partial fact (F32): no object supplied — the reviewer fills it in.
    const partial = e.object == null || e.object === '';
    const question = e.question ?? (partial ? e.note : undefined);
    const prefix = e.type ? (typePrefix[e.type] ?? '') : (partial ? typePrefix.question : '');
    const gloss = prefix + (question ?? e.note ?? '');
    const excerpt = e.commitSha ? `commit: ${e.commitSha}` : undefined;

    return {
      id: uuid(),
      sourceId,
      status: 'pending' as const,
      confidence,
      s: { kind: 'iri' as const, value: e.subject },
      p: { kind: 'iri' as const, value: e.predicate },
      o: { kind: 'literal' as const, value: partial ? '?' : e.object! },
      g: { kind: 'iri' as const, value: `urn:mcp:pending:${sourceId}` },
      // Carry BOTH through to the graph. Dropping `blocks` was the bug that made a partial
      // fact merely a gap instead of a priority — the graph knew it had a hole but not what
      // the hole cost. Dropping `agent` meant an answer could not be routed back to the
      // agent that asked, which breaks the moment more than one is running.
      ...(partial
        ? {
            needsObject: true,
            question,
            ...(e.blocks ? { blocks: Array.isArray(e.blocks) ? e.blocks : [e.blocks] } : {}),
            ...(e.agent ? { askedBy: e.agent } : {}),
          }
        : {}),
      ...(gloss ? { gloss } : {}),
      ...(excerpt ? { excerpt } : {}),
      createdAt: e.addedAt ? new Date(e.addedAt).getTime() : now,
      updatedAt: now,
    };
  });
  // F80.1 (kb:auto-merge): fold exact-identical notes in THIS batch so the user never triages
  // the same finding twice — the same COMPLETE fact said twice by different agents becomes one
  // review item. Only EXACT triple duplicates are dropped (the dedupe is unit-verified never to
  // touch distinct facts) and the highest-confidence copy is kept, so the blast radius is bounded
  // to removing noise. PARTIAL facts (F32 questions, object '?') are deliberately NOT deduped:
  // two questions on the same subject+predicate can carry different `blocks`/`question` metadata,
  // and folding them would silently drop what the hole costs — a destructive action must never be
  // silent. Cross-batch dedupe (against already-imported pending) also remains — that needs a
  // graph read, not just this batch.
  const { kept: deduped, folded } = dedupeCompletePending(sts);
  if (folded) console.info(`[F80.1] folded ${folded} duplicate pending note(s) before review`);

  // Origin 'agent' engages the F52 boundary in addStatements: these are agent-queued notes, so
  // any settled status is downgraded to a proposal — agents propose, the human settles.
  await addStatements(deduped, sourceId, { origin: 'agent' });
  return deduped.length;
}

/**
 * Flow a resolved partial-fact answer BACK to the waiting sub-agent (F32).
 * Appends one JSON line to knowledge.answers.jsonl in the workspace so an agent
 * polling that file can resume. No-op if no workspace is connected.
 */
export async function recordAnswer(answer: {
  subject: string; predicate: string; object: string;
  objectKind: 'iri' | 'literal'; agent?: string; question?: string;
}): Promise<void> {
  const existing = (await readFromWorkspace('knowledge.answers.jsonl')) ?? '';
  const line = JSON.stringify({ ...answer, answeredAt: new Date().toISOString() });
  await writeToWorkspace('knowledge.answers.jsonl', existing + line + '\n');
}

// ── Import KBs from workspace ────────────────────────────────────────────────

/** A `.ttl` discovered under the workspace, with its parsed metadata. */
type FolderEntry = { folderName: string; path: string[]; meta: KbMeta };

/** Read a folder entry's TTL + assets (conventional folders carry binary assets;
 *  loose `.ttl` files anywhere are inline-only). */
async function readFolderData(
  folder: FolderEntry
): Promise<{ ttl: string; assets: Map<string, Uint8Array> } | null> {
  const conventional = folder.path.length === 3 && folder.path[0] === 'kbs';
  if (conventional) {
    const d = await readKbFromFolder(folder.folderName);
    return d ? { ttl: d.ttl, assets: d.assets } : null;
  }
  const ttl = await readTtlByPath(folder.path);
  return ttl ? { ttl, assets: new Map<string, Uint8Array>() } : null;
}

/** Import ONE freshly-discovered folder as a new KB. Returns statements written,
 *  or 0 if empty/unreadable. */
async function importNewKb(folder: FolderEntry): Promise<number> {
  const data = await readFolderData(folder);
  if (!data?.ttl) return 0;
  const { ingestNewKb } = await import('./kb-import');
  const uri = `workspace://${folder.folderName}/${folder.folderName}.ttl`;
  const res = await ingestNewKb(data, folder.meta, uri);
  return res?.count ?? 0;
}

/** Re-import a changed folder into the EXISTING KB `kbId` (in place). */
async function updateExistingKb(kbId: string, folder: FolderEntry): Promise<number> {
  const data = await readFolderData(folder);
  if (!data?.ttl) return 0;
  const { ingestExistingKb } = await import('./kb-import');
  const uri = `workspace://${folder.folderName}/${folder.folderName}.ttl`;
  return ingestExistingKb(kbId, data, folder.meta, uri);
}

/**
 * Import KBs found in the workspace folder that don't exist in IndexedDB.
 * Reads each kbs/{name}/{name}.ttl (or legacy kbs/{name}/kb.ttl), parses it,
 * creates a Dexie DB, and registers the KB. Returns names imported/skipped.
 */
export async function importKbsFromWorkspace(): Promise<{ imported: string[]; skipped: string[] }> {
  const folders = await listKbFolders();
  if (folders.length === 0) return { imported: [], skipped: [] };

  const { getRegistry, findKbByStableId } = await import('../storage/kb-registry');
  const registry = getRegistry();
  const existing = new Set(registry.map(e => e.name.toLowerCase()));
  const existingStableIds = new Set<string>();
  for (const e of registry) if (e.stableId) existingStableIds.add(e.stableId);

  const imported: string[] = [];
  const skipped: string[] = [];

  for (const folder of folders) {
    const { folderName, meta } = folder;
    if (existing.has(meta.name.toLowerCase()) || existing.has(folderName.toLowerCase())) {
      skipped.push(meta.name);
      continue;
    }
    if (meta.stableId && (existingStableIds.has(meta.stableId) || findKbByStableId(meta.stableId))) {
      skipped.push(meta.name);
      continue;
    }
    try {
      const count = await importNewKb(folder);
      if (count === 0) { skipped.push(`${meta.name} (empty)`); continue; }
      // Baseline the hash so the poll loop won't immediately re-import it.
      markWritten(folder.path.join('/'), (await readTtlByPath(folder.path)) ?? '');
      imported.push(`${meta.name} (${count} statements)`);
    } catch (err) {
      console.warn(`[workspace] Failed to import ${meta.name}:`, err);
      skipped.push(`${meta.name} (parse error)`);
    }
  }

  return { imported, skipped };
}

// ── Pull: import new / update changed .ttl from disk ─────────────────────────

/**
 * Scan the linked folder for `.ttl` changes and reconcile them into IndexedDB:
 *  - a file with no matching KB → imported as a new KB;
 *  - a file whose content changed since we last saw it → re-imported into the
 *    existing KB (matched by stableId, else by name);
 *  - a file we ourselves just wrote (hash already seen) → skipped.
 * If the active KB is updated, its in-memory store is reloaded so the graph
 * reflects the change without a page reload.
 */
export async function pullFromWorkspace(): Promise<{ imported: string[]; updated: string[] }> {
  if (!_handle || _pulling) return { imported: [], updated: [] };
  _pulling = true;
  const imported: string[] = [];
  const updated: string[] = [];
  try {
    const folders = await listKbFolders();
    const { getRegistry, findKbByStableId, getCurrentKbId } = await import('../storage/kb-registry');
    const registry = getRegistry();
    const currentId = getCurrentKbId();
    let activeChanged = false;

    for (const folder of folders) {
      const key = folder.path.join('/');
      const ttl = await readTtlByPath(folder.path);
      if (!ttl) continue;
      const h = hashString(ttl);
      if (_seenHashes.get(key) === h) continue; // unchanged or our own write

      const match =
        (folder.meta.stableId
          ? (findKbByStableId(folder.meta.stableId) ?? registry.find(e => e.stableId === folder.meta.stableId))
          : undefined) ??
        registry.find(
          e =>
            e.name.toLowerCase() === folder.meta.name.toLowerCase() ||
            e.name.toLowerCase() === folder.folderName.toLowerCase()
        );

      try {
        if (match) {
          const count = await updateExistingKb(match.id, folder);
          if (count > 0) {
            updated.push(folder.meta.name);
            if (match.id === currentId) activeChanged = true;
          }
        } else {
          const count = await importNewKb(folder);
          if (count > 0) imported.push(folder.meta.name);
        }
        _seenHashes.set(key, h);
      } catch (err) {
        console.warn(`[workspace] pull failed for ${folder.meta.name}:`, err);
      }
    }

    if (imported.length || updated.length) {
      _lastSyncTime = Date.now();
      _syncedKbCount = folders.length;
      if (activeChanged) {
        const { loadAll } = await import('./kb.svelte');
        await loadAll();
      }
    }
  } finally {
    _pulling = false;
  }
  return { imported, updated };
}

/** Manual "resync now": pull disk→app, then push app→disk. */
export async function resyncNow(): Promise<{ imported: string[]; updated: string[]; pushed: number }> {
  const pulled = await pullFromWorkspace();
  const pushed = await syncAllKbs();
  return { ...pulled, pushed };
}

// ── Polling ──────────────────────────────────────────────────────────────────

/** Start the background poll loop (idempotent). No-op without a handle. */
export function startWorkspacePolling(ms: number = POLL_INTERVAL_MS): void {
  if (_pollTimer || !_handle || typeof setInterval === 'undefined') return;
  _pollTimer = setInterval(() => { void pullFromWorkspace(); }, ms);
}

export function stopWorkspacePolling(): void {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

/** Toggle auto-sync (persisted). Starts/stops polling to match. */
export function setAutoSync(on: boolean): void {
  _autoSyncEnabled = on;
  if (typeof localStorage !== 'undefined') localStorage.setItem(AUTOSYNC_KEY, on ? 'true' : 'false');
  if (on) { if (_handle) { void pullFromWorkspace().finally(() => startWorkspacePolling()); } }
  else stopWorkspacePolling();
}

/** TEST ONLY: link an already-obtained handle (e.g. an OPFS dir) without the
 *  native picker, so folder sync can be exercised in Playwright/headless. */
export function __linkHandleForTest(handle: FileSystemDirectoryHandle): void {
  _handle = handle;
  _name = handle.name;
  _state = 'connected';
}

// DEV/test-only: expose the sync internals on window so Playwright can exercise
// the two-way folder sync against a real (OPFS) directory handle — the native
// showDirectoryPicker can't be driven headless. Never attached in production.
if (typeof window !== 'undefined' && import.meta.env?.DEV) {
  (window as unknown as { __reckonsWorkspace?: unknown }).__reckonsWorkspace = {
    __linkHandleForTest, pullFromWorkspace, resyncNow,
    workspaceState, workspaceName, syncedKbCount, autoSyncEnabled, setAutoSync,
  };
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
