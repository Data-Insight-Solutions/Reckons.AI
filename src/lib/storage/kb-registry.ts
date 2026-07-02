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
};

const REGISTRY_KEY = 'kbRegistry';
const CURRENT_KEY = 'currentKbId';
const SESSION_KEY = 'sessionKbId';
const DEFAULT_ID = 'kbase';

const DEFAULT_ENTRY: KbEntry = { id: DEFAULT_ID, name: 'Default KB', createdAt: 0 };

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

/**
 * Resolve the active KB for this tab.
 * Priority: URL ?kb= > sessionStorage > localStorage > default.
 */
export function getCurrentKbId(): string {
  if (typeof window === 'undefined') return DEFAULT_ID;

  // 1. URL param (bookmarkable)
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('kb');
    if (fromUrl) {
      // Persist to sessionStorage so in-tab navigation keeps this KB
      sessionStorage.setItem(SESSION_KEY, fromUrl);
      return fromUrl;
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
  const id = `kbase_${Date.now()}`;
  const entry: KbEntry = { id, name, createdAt: Date.now() };
  const reg = getRegistry();
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
export function registerStableId(dbName: string, stableId: string, statementCount?: number): void {
  const reg = getRegistry();
  const entry = reg.find((k) => k.id === dbName);
  if (entry) {
    entry.stableId = stableId;
    if (statementCount !== undefined) entry.statementCount = statementCount;
    saveRegistry(reg);
  }
}
