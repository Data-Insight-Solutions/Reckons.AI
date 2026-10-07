/**
 * Google Drive folder sync (F56) — the cloud sibling of the local File System
 * Access folder sync (workspace.svelte.ts).
 *
 * Link a Drive folder and the app keeps it in step with your graphs: push each
 * KB out as `{name}.ttl`, and pull `.ttl` files back in, reconciling new graphs
 * and updating changed ones through the shared kb-import reconcile. Uses the
 * `drive.file` OAuth scope, so it only ever touches the folder + files it owns.
 *
 * v1 syncs the graph TTL (URL/inline images included). Binary sidecar assets
 * (preview blobs, GLB models) are a follow-up — they need per-file uploads.
 */
import { db, KBaseDB, DEFAULT_SETTINGS } from '../storage/db';
import { getRegistry, registerStableId } from '../storage/kb-registry';
import { getOrCreateStableId } from '../storage/kb-fingerprint';
import { settings } from './settings.svelte';

const FOLDER_KEY = 'reckons:drive-folder';
const AUTOSYNC_KEY = 'reckons:drive-autosync';
const DEFAULT_FOLDER_NAME = 'Reckons.AI';
const PUSH_DEBOUNCE_MS = 5_000;   // network write — coalesce bursts of edits
const POLL_INTERVAL_MS = 45_000;  // cloud pull — gentler than the local 10s poll

let folderId = $state<string | null>(null);
let _folderName = $state<string | null>(null);
let lastSync = $state<number | null>(null);
let syncedCount = $state(0);
let busy = $state(false);
let autoSync = $state<boolean>(readAutoSyncPref());
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** file path-key → last-seen content hash, to skip re-pulling our own writes. */
const _seenHashes = new Map<string, string>();

export function driveFolderName(): string | null { return _folderName; }
export function driveLinked(): boolean { return folderId !== null; }
export function driveLastSync(): number | null { return lastSync; }
export function driveSyncedCount(): number { return syncedCount; }
export function driveBusy(): boolean { return busy; }
export function driveAutoSync(): boolean { return autoSync; }
/** True once a Google client id is configured (Settings → Integrations). */
export function driveConfigured(): boolean { return !!settings().googleClientId; }

function readAutoSyncPref(): boolean {
  if (typeof localStorage === 'undefined') return false; // default OFF (network + quota)
  return localStorage.getItem(AUTOSYNC_KEY) === 'true';
}

/** Refresh the Drive token silently (no popup once consent is granted). Returns
 *  false if interactive re-auth is needed — callers bail instead of spamming. */
async function ensureDriveAuth(): Promise<boolean> {
  const clientId = settings().googleClientId;
  if (!clientId) return false;
  try {
    const { ensureAuth } = await import('../integrations/google/auth');
    await ensureAuth(clientId);
    return true;
  } catch {
    return false;
  }
}

/** FNV-1a 32-bit hash — cheap change detection for file text. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
}

/** Restore a previously-linked Drive folder (id + name) from localStorage. */
export function loadDriveFolder(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(FOLDER_KEY);
    if (!raw) return;
    const { id, name } = JSON.parse(raw);
    folderId = id ?? null;
    _folderName = name ?? null;
  } catch { /* ignore */ }
}

function persistFolder(): void {
  if (typeof localStorage === 'undefined') return;
  if (folderId) localStorage.setItem(FOLDER_KEY, JSON.stringify({ id: folderId, name: _folderName }));
  else localStorage.removeItem(FOLDER_KEY);
}

/**
 * Sign in (if needed) and ensure a Drive folder named `name` exists, linking it
 * as the sync target. Returns true on success.
 */
export async function linkDriveFolder(name: string = DEFAULT_FOLDER_NAME): Promise<boolean> {
  const clientId = settings().googleClientId;
  if (!clientId) return false;
  try {
    const { ensureAuth } = await import('../integrations/google/auth');
    const { ensureFolder } = await import('../integrations/google/drive');
    await ensureAuth(clientId);
    const id = await ensureFolder(name);
    folderId = id;
    _folderName = name;
    persistFolder();
    if (autoSync) startDrivePolling();
    return true;
  } catch (e) {
    console.error('[drive-sync] link failed:', e);
    return false;
  }
}

export function unlinkDrive(): void {
  stopDrivePolling();
  if (pushTimer) { clearTimeout(pushTimer); pushTimer = null; }
  folderId = null;
  _folderName = null;
  assetsFolderId = null;
  lastSync = null;
  syncedCount = 0;
  _seenHashes.clear();
  persistFolder();
}

type CollectedAsset = { entityIri: string; category: string; filename: string; data: Uint8Array };

/** Serialize one KB to Turtle (graph statements + asset references) and collect
 *  its binary sidecar assets (preview/model/icon blobs). */
async function serializeKnowledgeBase(kbId: string): Promise<{ ttl: string; assets: CollectedAsset[] } | null> {
  const { toTurtleFull } = await import('../rdf/serialize');
  const { collectAssets, assetTriples } = await import('../storage/kb-assets');
  const kbDb = kbId === db.name ? db : new KBaseDB(kbId);
  try {
    if (kbDb !== db) await kbDb.open();
    const statements = await kbDb.statements.toArray();
    if (statements.length === 0 && kbId !== 'kbase') return null;
    const sources = await kbDb.sources.toArray();
    const savedSettings = await kbDb.settings.get('main');
    const stableId = await getOrCreateStableId(savedSettings?.kbStableId, async (id) => {
      await kbDb.settings.put({ ...DEFAULT_SETTINGS, ...savedSettings, kbStableId: id });
    });
    registerStableId(kbId, stableId, statements.length);
    const assets = (await collectAssets(kbDb)) as CollectedAsset[];
    // LOSSLESS export (F107.4): all statuses + provenance, so a re-pull cannot drop review state.
    const ttl = toTurtleFull(statements, sources, { kbStableId: stableId }) + (await assetTriples(kbDb, assets as never));
    return { ttl, assets };
  } finally {
    if (kbDb !== db) kbDb.close();
  }
}

let assetsFolderId: string | null = null;
/** Find-or-create the shared `assets/` subfolder under the linked Drive folder. */
async function ensureAssetsFolder(): Promise<string | null> {
  if (!folderId) return null;
  if (assetsFolderId) return assetsFolderId;
  const { ensureFolder } = await import('../integrations/google/drive');
  assetsFolderId = await ensureFolder('assets', folderId);
  return assetsFolderId;
}

/** Sanitize a KB name into a safe Drive filename stem (mirrors the local layout). */
function fileStem(name: string, id: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return s || id;
}

/** Push every registered KB out to the linked Drive folder. Returns files written. */
export async function driveSyncPush(): Promise<number> {
  if (!folderId || busy) return 0;
  if (!(await ensureDriveAuth())) return 0;
  busy = true;
  try {
    const { listFolderTurtles, uploadTurtleToFolder, uploadBinaryToFolder, listFolderFiles } =
      await import('../integrations/google/drive');
    const { extToMime } = await import('../storage/kb-assets');
    const existing = new Map((await listFolderTurtles(folderId)).map((f) => [f.name, f.id]));
    let pushed = 0;
    for (const entry of getRegistry()) {
      const ser = await serializeKnowledgeBase(entry.id);
      if (ser == null) continue;
      const stem = fileStem(entry.name, entry.id);
      const filename = `${stem}.ttl`;
      try {
        await uploadTurtleToFolder(filename, ser.ttl, folderId, existing.get(filename));
        _seenHashes.set(filename, hashString(ser.ttl)); // loop guard: don't re-pull our own write

        // Binary sidecar assets → a shared assets/ subfolder, KB-scoped filenames.
        if (ser.assets.length) {
          const af = await ensureAssetsFolder();
          if (af) {
            const existingAssets = new Map((await listFolderFiles(af)).map((f) => [f.name, f.id]));
            for (const a of ser.assets) {
              const driveName = `${stem}__${a.category}__${a.filename}`;
              await uploadBinaryToFolder(driveName, a.data, extToMime(a.filename), af, existingAssets.get(driveName));
            }
          }
        }
        pushed++;
      } catch (e) {
        console.warn(`[drive-sync] push failed for "${entry.name}":`, e);
      }
    }
    syncedCount = pushed;
    lastSync = Date.now();
    return pushed;
  } finally {
    busy = false;
  }
}

/**
 * Pull `.ttl` files from the linked Drive folder: import new graphs, update
 * changed ones (matched by stable id, else by name), skip unchanged / our own
 * writes. Returns the names imported/updated.
 */
export async function driveSyncPull(): Promise<{ imported: string[]; updated: string[] }> {
  const imported: string[] = [];
  const updated: string[] = [];
  if (!folderId || busy) return { imported, updated };
  if (!(await ensureDriveAuth())) return { imported, updated };
  busy = true;
  try {
    const { listFolderTurtles, downloadFile } = await import('../integrations/google/drive');
    const { getCurrentKbId } = await import('../storage/kb-registry');
    const { ingestNewKb, ingestExistingKnowledgeBase: ingestExistingKb } = await import('./kb-import');
    const registry = getRegistry();
    const currentId = getCurrentKbId();
    let activeChanged = false;

    for (const file of await listFolderTurtles(folderId)) {
      let ttl: string;
      try { ttl = await downloadFile(file.id); } catch { continue; }
      const h = hashString(ttl);
      if (_seenHashes.get(file.name) === h) continue; // unchanged or our own write

      const folderName = file.name.replace(/\.ttl$/, '');
      const stableId = ttl.match(/kbStableId[>"]\s+"([^"]+)"/)?.[1];
      const meta = { name: folderName, stableId };

      // Pull any binary sidecar assets the TTL references from the assets/ subfolder.
      const assets = new Map<string, Uint8Array>();
      const { parseAssetRefs } = await import('../storage/kb-assets');
      const refs = parseAssetRefs(ttl);
      if (refs.length) {
        const { listFolderFiles, downloadFileBytes } = await import('../integrations/google/drive');
        const af = await ensureAssetsFolder();
        if (af) {
          const files = new Map((await listFolderFiles(af)).map((f) => [f.name, f.id]));
          for (const ref of refs) {
            const fname = ref.value.split('/').pop() ?? '';
            const fid = files.get(`${folderName}__${ref.category}__${fname}`);
            if (fid) assets.set(ref.value, await downloadFileBytes(fid));
          }
        }
      }
      const data = { ttl, assets };
      const uri = `gdrive://${_folderName}/${file.name}`;

      const match =
        (stableId && registry.find((e) => e.stableId === stableId)) ??
        registry.find((e) => e.name.toLowerCase() === folderName.toLowerCase());

      try {
        if (match) {
          const count = await ingestExistingKb(match.id, data, meta, uri);
          if (count > 0) { updated.push(folderName); if (match.id === currentId) activeChanged = true; }
        } else {
          const res = await ingestNewKb(data, meta, uri);
          if (res && res.count > 0) imported.push(folderName);
        }
        _seenHashes.set(file.name, h);
      } catch (e) {
        console.warn(`[drive-sync] pull failed for "${file.name}":`, e);
      }
    }

    if (imported.length || updated.length) {
      lastSync = Date.now();
      if (activeChanged) {
        const { loadAll } = await import('./kb.svelte');
        await loadAll();
      }
    }
    return { imported, updated };
  } finally {
    busy = false;
  }
}

/** Manual resync: pull cloud→app, then push app→cloud. */
export async function driveResyncNow(): Promise<{ imported: string[]; updated: string[]; pushed: number }> {
  const pulled = await driveSyncPull();
  const pushed = await driveSyncPush();
  return { ...pulled, pushed };
}

// ── Auto-sync (opt-in) ───────────────────────────────────────────────────────

/** Debounced push after a KB mutation. No-op unless linked with auto-sync on. */
export function scheduleDrivePush(): void {
  if (!folderId || !autoSync) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; void driveSyncPush(); }, PUSH_DEBOUNCE_MS);
}

/** Poll the Drive folder for external changes (idempotent). */
export function startDrivePolling(ms: number = POLL_INTERVAL_MS): void {
  if (pollTimer || !folderId || typeof setInterval === 'undefined') return;
  pollTimer = setInterval(() => { void driveSyncPull(); }, ms);
}

export function stopDrivePolling(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

/** Toggle auto-sync (persisted). Starts/stops polling to match. */
export function setDriveAutoSync(on: boolean): void {
  autoSync = on;
  if (typeof localStorage !== 'undefined') localStorage.setItem(AUTOSYNC_KEY, on ? 'true' : 'false');
  if (on && folderId) { void driveSyncPush().finally(() => startDrivePolling()); }
  else stopDrivePolling();
}
