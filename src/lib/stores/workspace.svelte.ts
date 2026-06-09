/**
 * Local Workspace — a user-selected directory on their filesystem.
 *
 * When a workspace is set it serves as:
 *  - Default export location for TTL snapshots (knowledge.ttl — read by MCP server)
 *  - Profile sync location (settings_profile.json)
 *
 * The FileSystemDirectoryHandle is stored in IndexedDB (structured-clone safe),
 * but PERMISSION must be re-granted each browser session.  We store the folder
 * name separately in SettingsRecord so the UI can show "reconnect <name>" even
 * before permission is granted.
 *
 * Requires the File System Access API — Chrome/Edge only (not Firefox/Safari).
 */
import { db } from '../storage/db';
import { updateSettings } from './settings.svelte';

/** Filename written to the workspace dir on every KB mutation (read by the MCP server). */
export const WORKSPACE_KB_FILE = 'knowledge.ttl';

let _handle = $state<FileSystemDirectoryHandle | null>(null);
let _name   = $state<string | null>(null);
let _state  = $state<'none' | 'disconnected' | 'connected'>('none');

export function workspaceHandle(): FileSystemDirectoryHandle | null { return _handle; }
export function workspaceName(): string | null { return _name; }
export function workspaceState(): 'none' | 'disconnected' | 'connected' { return _state; }

export function supportsWorkspace(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Called on app startup — loads the stored handle and checks current permission. */
export async function loadWorkspace(): Promise<void> {
  const row = await db.workspace.get('main');
  if (!row) { _state = 'none'; return; }
  _name = row.name;
  try {
    const perm = await row.handle.queryPermission({ mode: 'readwrite' });
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
    const handle = await (window as Window & { showDirectoryPicker(o?: { mode?: string }): Promise<FileSystemDirectoryHandle> })
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
    const perm = await row.handle.requestPermission({ mode: 'readwrite' });
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
  await updateSettings({ workspaceName: undefined });
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

// ── Workspace TTL auto-export ─────────────────────────────────────────────────
//
// After each KB mutation, schedule a debounced clean export to knowledge.ttl.
// The MCP server watches this file and reloads automatically.

let _wsExportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Schedule a clean TTL export to knowledge.ttl in the workspace directory.
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
    // Lazy import to avoid circular dependency
    const { toTurtle } = await import('../rdf/serialize');
    const statements = await db.statements.toArray();
    const turtle = toTurtle(statements);
    await writeToWorkspace(WORKSPACE_KB_FILE, turtle);
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
