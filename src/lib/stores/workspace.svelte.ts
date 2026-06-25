/**
 * Local Workspace — a user-selected directory on their filesystem.
 *
 * When a workspace is set it serves as:
 *  - Persistent home for all KBs (kbs/{name}/kb.ttl + meta.json + sources.json)
 *  - Default export location for MCP server (knowledge.ttl — backward compat)
 *  - Profile sync location (settings_profile.json)
 *  - Future: model storage, cross-device sync
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
  sourceCount: number;
  dbName: string;
};

/**
 * Write one KB's data to the workspace folder: kbs/{folderName}/kb.ttl + meta.json + sources.json
 */
export async function writeKbToFolder(
  entry: KbEntry,
  ttl: string,
  sources: unknown[],
  stableId?: string
): Promise<void> {
  if (!_handle) return;
  try {
    const kbsDir = await getOrCreateDir(_handle, 'kbs');
    const folderName = kbFolderName(entry.name, entry.id);
    const kbDir = await getOrCreateDir(kbsDir, folderName);

    const meta: KbMeta = {
      stableId: stableId || entry.stableId,
      name: entry.name,
      description: entry.description,
      color: entry.color,
      createdAt: entry.createdAt,
      lastModified: Date.now(),
      statementCount: entry.statementCount ?? 0,
      sourceCount: sources.length,
      dbName: entry.id,
    };

    await Promise.all([
      writeToDir(kbDir, 'kb.ttl', ttl),
      writeToDir(kbDir, 'meta.json', JSON.stringify(meta, null, 2)),
      writeToDir(kbDir, 'sources.json', JSON.stringify(sources, null, 2)),
    ]);
  } catch (e) {
    console.warn(`[workspace] KB folder write failed for "${entry.name}":`, e);
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
 */
export async function readKbFromFolder(folderName: string): Promise<{
  ttl: string;
  meta: KbMeta;
  sources: unknown[];
} | null> {
  if (!_handle) return null;
  try {
    const kbsDir = await _handle.getDirectoryHandle('kbs');
    const kbDir = await kbsDir.getDirectoryHandle(folderName);

    const [ttl, metaText, sourcesText] = await Promise.all([
      readFromDir(kbDir, 'kb.ttl'),
      readFromDir(kbDir, 'meta.json'),
      readFromDir(kbDir, 'sources.json'),
    ]);

    if (!ttl || !metaText) return null;
    const meta = JSON.parse(metaText) as KbMeta;
    const sources = sourcesText ? JSON.parse(sourcesText) : [];

    return { ttl, meta, sources };
  } catch {
    return null;
  }
}

/**
 * Sync all registered KBs to the workspace folder.
 * Exports each KB's TTL + meta + sources to kbs/{name}/.
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
      const sources = await kbDb.sources.toArray();
      const settings = await kbDb.settings.get('main');
      const stableId = settings?.kbStableId;

      if (statements.length === 0 && entry.id !== 'kbase') {
        // Skip empty non-default KBs
        if (kbDb !== db) kbDb.close();
        continue;
      }

      const ttl = toTurtle(statements);
      await writeKbToFolder(entry, ttl, sources, stableId);
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
    const sources = await db.sources.toArray();
    const settings = await db.settings.get('main');
    const ttl = toTurtle(statements);

    // Write legacy flat file for MCP server
    await writeToWorkspace(WORKSPACE_KB_FILE, ttl);

    // Write to multi-KB folder structure
    const { getCurrentKbId } = await import('../storage/kb-registry');
    const currentId = getCurrentKbId();
    const registry = getRegistry();
    const entry = registry.find(e => e.id === currentId);
    if (entry) {
      await writeKbToFolder(entry, ttl, sources, settings?.kbStableId);
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
