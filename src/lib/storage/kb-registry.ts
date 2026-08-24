/**
 * Registry of all local knowledge bases.
 * Stored in localStorage so it persists without needing a running Dexie instance.
 *
 * Per-tab KB support:
 *   - The *active* KB for a tab is resolved as:
 *       1. URL ?kb=<id> param  (highest priority — enables bookmarkable links)
 *       2. sessionStorage       (per-tab override, survives in-tab navigation)
 *       3. localStorage         (legacy fallback, shared across tabs)
 *       4. 'kbase' default
 *   - switchToKb() sets sessionStorage + localStorage, then reloads.
 *   - Opening a link with ?kb=<id> in a new tab auto-activates that KB.
 */

export type KbEntry = {
  id: string;
  name: string;
  createdAt: number;
  /** User-set description for the KB */
  description?: string;
  /** Accent color override (hex) */
  color?: string;
  /** Whether the user has bookmarked/starred this KB */
  bookmarked?: boolean;
  /** Timestamp of last time data was written/modified */
  lastModified?: number;
  /** Stable UUID from settings.kbStableId — used for KB Leap cross-references */
  stableId?: string;
  /** Approximate confirmed statement count (updated on save) */
  statementCount?: number;
  /**
   * Set on an ARCHIVE graph (F97): the stableId (or failing that, the name) of the graph whose
   * history it holds. Present only on graphs named "<parent> (archives)", and what lets the
   * settings page show an archive beside its parent rather than as an unexplained sibling.
   */
  archiveOf?: string;
  /**
   * Directory (no filename) this graph was last discovered at inside the linked workspace folder,
   * e.g. "kbs/clients/acme". Recorded so the graph list can be grouped the way the user organised
   * their own filesystem, rather than only by how they happened to spell the names.
   *
   * A CACHE OF WHERE A FILE WAS, NOT A CLAIM ABOUT WHERE IT IS. The folder can be moved or the
   * workspace unlinked without the app noticing, so this is refreshed from discovery and must
   * never be treated as authoritative for reading a file — listKbFolders() is.
   */
  folderPath?: string;
};

const REGISTRY_KEY = 'kbRegistry';
const CURRENT_KEY = 'currentKbId';
const SESSION_KEY = 'sessionKbId';
const DEFAULT_ID = 'kbase';

const DEFAULT_ENTRY: KbEntry = { id: DEFAULT_ID, name: 'Default Graph', createdAt: 0 };

/**
 * Observe registry writes made by another tab.
 *
 * The browser deliberately does not dispatch `storage` back to the tab that made the write, so
 * local actions can keep updating their component state synchronously while other tabs re-read
 * the shared registry. A `null` key represents localStorage.clear().
 */
export function subscribeRegistry(callback: (registry: KbEntry[]) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== localStorage) return;
    if (event.key !== REGISTRY_KEY && event.key !== null) return;
    callback(getRegistry());
  };

  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

export function getRegistry(): KbEntry[] {
  if (typeof window === 'undefined') return [DEFAULT_ENTRY];
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return [DEFAULT_ENTRY];
    const parsed = JSON.parse(raw) as KbEntry[];
    if (!parsed.find((k) => k.id === DEFAULT_ID)) {
      parsed.unshift(DEFAULT_ENTRY);
    }
    return parsed;
  } catch {
    return [DEFAULT_ENTRY];
  }
}

function saveRegistry(reg: KbEntry[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
}

/** Folder/display-name normalization, shared by name matching below. */
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/['"]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Resolve a `?kb=` value to a real graph id: an exact id wins, then a graph whose NAME matches,
 * and only failing both is the value used as a literal id.
 *
 * Ids are opaque (`createKb` mints `kbase_<timestamp>`), so a human-written or shared link says
 * `?kb=roadmap` meaning the graph CALLED roadmap. Taken literally that opened a brand-new empty
 * database beside the real one: the folder-synced graph kept its generated id, so the link led to
 * an empty graph with no folder link and no facts, while the populated one sat in the picker
 * under the same name. Matching on name first makes the link mean what it plainly says.
 */
export function resolveKbParam(param: string, reg: KbEntry[] = getRegistry()): string {
  const trimmed = param.trim();
  if (!trimmed) return DEFAULT_ID;
  if (reg.some((k) => k.id === trimmed)) return trimmed;
  const target = slug(trimmed);
  const byName = reg.find((k) => slug(k.name) === target);
  if (byName) return byName.id;

  // NOTHING MATCHED — fall back to the default graph rather than inventing one.
  //
  // Using the raw value as an id looks harmless and is the whole bug class. Visit `?kb=roadmap`
  // once with an empty registry — a cleared cache, or any moment before the workspace folder has
  // synced — and it mints an empty graph whose id is literally `roadmap`. The real roadmap then
  // arrives from the folder with a generated `kbase_<timestamp>` id, and because an exact id match
  // wins above, that link is pinned to the empty shadow permanently. Worse, the shadow then syncs
  // ITSELF over the canonical file.
  //
  // A link naming a graph that does not exist yet is a link to nothing. Say so by landing on the
  // default graph; creating graphs stays a deliberate act in the graph picker.
  return DEFAULT_ID;
}

/**
 * True when `?kb=` named a graph this browser does not have, so the caller can say "no graph named
 * X — showing the default" instead of silently showing the wrong graph.
 */
export function isUnresolvedKbParam(param: string, reg: KbEntry[] = getRegistry()): boolean {
  const trimmed = param.trim();
  if (!trimmed) return false;
  const target = slug(trimmed);
  return !reg.some((k) => k.id === trimmed || slug(k.name) === target);
}

/**
 * Resolve the active KB for this tab.
 * Priority: URL ?kb= > sessionStorage > localStorage > default.
 */
export function getCurrentKbId(): string {
  if (typeof window === 'undefined') return DEFAULT_ID;

  // 1. URL param (bookmarkable) — by id OR by graph name.
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('kb');
    if (fromUrl) {
      const resolved = resolveKbParam(fromUrl);
      // Persist to sessionStorage so in-tab navigation keeps this KB
      sessionStorage.setItem(SESSION_KEY, resolved);
      return resolved;
    }
  } catch { /* ignore URL parse errors */ }

  // 2. Session storage (per-tab)
  const fromSession = sessionStorage.getItem(SESSION_KEY);
  if (fromSession) return fromSession;

  // 3. localStorage (shared default)
  return localStorage.getItem(CURRENT_KEY) ?? DEFAULT_ID;
}

/** Display name of the active graph (KB), for titles and export filenames. */
export function getCurrentKbName(): string {
  const id = getCurrentKbId();
  return getRegistry().find((k) => k.id === id)?.name ?? DEFAULT_ENTRY.name;
}

/**
 * File-safe slug of the active graph's name for export filenames, e.g.
 * "My Research Notes" -> "my-research-notes". Falls back to "graph".
 */
export function kbFileSlug(name = getCurrentKbName()): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'graph';
}

/**
 * Switch the active KB for this tab and reload.
 * Also updates localStorage as the global default for new tabs.
 */
export function switchToKb(id: string): void {
  if (typeof window === 'undefined') return;
  // Set per-tab session
  if (id === DEFAULT_ID) {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CURRENT_KEY);
  } else {
    sessionStorage.setItem(SESSION_KEY, id);
    localStorage.setItem(CURRENT_KEY, id);
  }
  window.location.reload();
}

/**
 * Build a URL that opens a specific KB (for "open in new tab" links).
 */
export function kbUrl(id: string, path = '/'): string {
  if (id === DEFAULT_ID) return path;
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}kb=${encodeURIComponent(id)}`;
}

export function createKb(name: string): KbEntry {
  const reg = getRegistry();

  // Date.now() has MILLISECOND resolution, so two graphs created in the same tick used to collide
  // on id — and a colliding id means two different graphs silently share ONE Dexie database, which
  // corrupts both. Rare when a human clicks "create"; routine once anything creates graphs
  // programmatically (F97 ensureArchiveKb) or when two tabs race. Found by an archive-store test
  // that created two archives in a single tick, 2026-07-18.
  const taken = new Set(reg.map((k) => k.id));
  const base = `kbase_${Date.now()}`;
  let id = base;
  for (let n = 1; taken.has(id); n++) id = `${base}_${n}`;

  const entry: KbEntry = { id, name, createdAt: Date.now() };
  reg.push(entry);
  saveRegistry(reg);
  return entry;
}

export function updateKbName(id: string, name: string): void {
  const reg = getRegistry();
  const entry = reg.find((k) => k.id === id);
  if (entry) {
    entry.name = name;
    saveRegistry(reg);
  }
}

export function updateKbEntry(id: string, patch: Partial<Omit<KbEntry, 'id'>>): void {
  const reg = getRegistry();
  const entry = reg.find((k) => k.id === id);
  if (entry) {
    Object.assign(entry, patch);
    saveRegistry(reg);
  }
}

export function toggleBookmark(id: string): boolean {
  const reg = getRegistry();
  const entry = reg.find((k) => k.id === id);
  if (!entry) return false;
  entry.bookmarked = !entry.bookmarked;
  saveRegistry(reg);
  return entry.bookmarked;
}

export function getBookmarkedKbs(): KbEntry[] {
  return getRegistry().filter((k) => k.bookmarked);
}

export function removeKbFromRegistry(id: string): void {
  if (id === DEFAULT_ID) return;
  const reg = getRegistry().filter((k) => k.id !== id);
  saveRegistry(reg);
  if (getCurrentKbId() === id) switchToKb(DEFAULT_ID);
}

/** Touch the lastModified timestamp for the current KB. */
export function touchKb(id: string): void {
  updateKbEntry(id, { lastModified: Date.now() });
}

/**
 * Find a KB entry by its stable UUID (from settings.kbStableId).
 * Used by KB Leap navigation to resolve a target KB.
 */
export function findKbByStableId(stableId: string): KbEntry | undefined {
  return getRegistry().find((k) => k.stableId === stableId);
}

/**
 * Register the stable ID and statement count for a KB.
 * Called on app load after settings are available.
 */
/**
 * Ensure the active graph exists in the registry, creating an entry for it if not.
 *
 * A `?kb=<id>` link opens (and Dexie creates) a database for any id at all, but nothing ever added
 * it to the registry: `registerStableId` only patches entries that already exist. The graph was
 * therefore real and populated yet absent from /kb, and `getCurrentKbName()` reported it as
 * 'Default Graph' — the name every other graph-scoped decision is made from.
 *
 * The id doubles as the initial display name so a shared link like `?kb=roadmap` presents as
 * "roadmap" rather than something opaque. Renaming afterwards is ordinary `updateKbName`.
 * Returns the entry, existing or newly created.
 */
export function ensureKbRegistered(id: string, name = id): KbEntry {
  const reg = getRegistry();
  const existing = reg.find((k) => k.id === id);
  if (existing) return existing;

  const entry: KbEntry = { id, name, createdAt: Date.now() };
  reg.push(entry);
  saveRegistry(reg);
  return entry;
}

export function registerStableId(dbName: string, stableId: string, statementCount?: number): void {
  const reg = getRegistry();
  const entry = reg.find((k) => k.id === dbName);
  if (entry) {
    entry.stableId = stableId;
    if (statementCount !== undefined) entry.statementCount = statementCount;
    saveRegistry(reg);
  }
}
