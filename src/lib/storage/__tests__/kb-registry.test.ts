import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  getRegistry,
  createKb,
  updateKbName,
  removeKbFromRegistry,
  getCurrentKbId,
  findKbByStableId,
  registerStableId,
  updateKbEntry,
  toggleBookmark,
  getBookmarkedKbs,
  kbUrl
} from '../kb-registry';

// ── Regression: id collision ──────────────────────────────────────────────────

describe('createKb id uniqueness', () => {
  // A colliding id means two graphs share ONE Dexie database and corrupt each other. Date.now()
  // is millisecond-resolution, so anything creating graphs programmatically (F97 archive graphs)
  // or two tabs racing would hit this. Found by an archive-store test, 2026-07-18.
  it('gives every graph a distinct id even when created in the same millisecond', () => {
    localStorage.clear();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) ids.add(createKb(`Graph ${i}`).id);
    expect(ids.size).toBe(25);
  });

  it('keeps every created graph in the registry', () => {
    localStorage.clear();
    for (let i = 0; i < 10; i++) createKb(`G${i}`);
    // 10 created + the always-present default entry.
    expect(getRegistry().length).toBe(11);
  });
});

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // Use fake timers so we can advance Date.now() between createKb() calls.
  // createKb() generates IDs as `kbase_${Date.now()}`, so two calls within
  // the same real millisecond would collide.
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Create a KB and advance the fake clock by 1 ms so the next call gets a
 * distinct timestamp-based ID.
 */
function mkKb(name: string) {
  const entry = createKb(name);
  vi.advanceTimersByTime(1);
  return entry;
}

// ── Constants (mirrored from module) ──────────────────────────────────────────

const DEFAULT_ID = 'kbase';

// ── getRegistry ───────────────────────────────────────────────────────────────

describe('getRegistry', () => {
  it('returns the default entry when localStorage is empty', () => {
    const reg = getRegistry();
    expect(reg).toHaveLength(1);
    expect(reg[0].id).toBe(DEFAULT_ID);
    expect(reg[0].name).toBe('Default Graph');
  });

  it('always includes the default entry even if it was not stored', () => {
    // Write a registry that lacks the default entry
    localStorage.setItem('kbRegistry', JSON.stringify([{ id: 'kbase_custom', name: 'Custom', createdAt: 1 }]));
    const reg = getRegistry();
    expect(reg.find((k) => k.id === DEFAULT_ID)).toBeDefined();
  });

  it('returns stored entries alongside the default', () => {
    mkKb('Alpha');
    mkKb('Beta');
    const reg = getRegistry();
    expect(reg.length).toBeGreaterThanOrEqual(3); // default + Alpha + Beta
  });

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('kbRegistry', 'not-valid-json{{{');
    const reg = getRegistry();
    expect(reg).toHaveLength(1);
    expect(reg[0].id).toBe(DEFAULT_ID);
  });
});

// ── createKb ──────────────────────────────────────────────────────────────────

describe('createKb', () => {
  it('returns a KbEntry with the given name', () => {
    const entry = mkKb('My KB');
    expect(entry.name).toBe('My KB');
  });

  it('assigns an id that starts with "kbase_"', () => {
    const entry = mkKb('Test');
    expect(entry.id).toMatch(/^kbase_\d+$/);
  });

  it('persists the new entry so getRegistry reflects it', () => {
    const entry = mkKb('Persisted');
    const reg = getRegistry();
    expect(reg.find((k) => k.id === entry.id)).toBeDefined();
  });

  it('generates unique IDs for successive calls', () => {
    const a = mkKb('First');
    const b = mkKb('Second');
    expect(a.id).not.toBe(b.id);
  });

  it('sets createdAt to a recent timestamp', () => {
    const before = Date.now();
    const entry = mkKb('Timed');
    const after = Date.now();
    expect(entry.createdAt).toBeGreaterThanOrEqual(before);
    expect(entry.createdAt).toBeLessThanOrEqual(after);
  });

  it('allows multiple KBs to coexist', () => {
    mkKb('KB One');
    mkKb('KB Two');
    mkKb('KB Three');
    const reg = getRegistry();
    const names = reg.map((k) => k.name);
    expect(names).toContain('KB One');
    expect(names).toContain('KB Two');
    expect(names).toContain('KB Three');
  });
});

// ── updateKbName ──────────────────────────────────────────────────────────────

describe('updateKbName', () => {
  it('renames an existing KB', () => {
    const entry = mkKb('Original');
    updateKbName(entry.id, 'Renamed');
    const reg = getRegistry();
    const found = reg.find((k) => k.id === entry.id);
    expect(found?.name).toBe('Renamed');
  });

  it('does nothing for an unknown ID', () => {
    const before = getRegistry().length;
    updateKbName('nonexistent-id', 'Anything');
    expect(getRegistry().length).toBe(before);
  });

  it('only affects the targeted entry', () => {
    const a = mkKb('Alpha');
    const b = mkKb('Beta');
    updateKbName(a.id, 'Alpha Renamed');
    const reg = getRegistry();
    expect(reg.find((k) => k.id === b.id)?.name).toBe('Beta');
  });
});

// ── removeKbFromRegistry ──────────────────────────────────────────────────────

describe('removeKbFromRegistry', () => {
  it('removes a KB that was added', () => {
    const entry = mkKb('To Remove');
    removeKbFromRegistry(entry.id);
    const reg = getRegistry();
    expect(reg.find((k) => k.id === entry.id)).toBeUndefined();
  });

  it('does not remove the default KB', () => {
    removeKbFromRegistry(DEFAULT_ID);
    const reg = getRegistry();
    expect(reg.find((k) => k.id === DEFAULT_ID)).toBeDefined();
  });

  it('leaves other KBs intact', () => {
    const a = mkKb('Keep Me');
    const b = mkKb('Remove Me');
    removeKbFromRegistry(b.id);
    const reg = getRegistry();
    expect(reg.find((k) => k.id === a.id)).toBeDefined();
  });

  it('is idempotent — removing twice does not throw', () => {
    const entry = mkKb('Twice');
    removeKbFromRegistry(entry.id);
    expect(() => removeKbFromRegistry(entry.id)).not.toThrow();
  });
});

// ── getCurrentKbId ────────────────────────────────────────────────────────────

describe('getCurrentKbId', () => {
  it('returns the default ID when nothing is set', () => {
    expect(getCurrentKbId()).toBe(DEFAULT_ID);
  });

  it('returns the value stored in localStorage', () => {
    localStorage.setItem('currentKbId', 'kbase_12345');
    expect(getCurrentKbId()).toBe('kbase_12345');
  });

  it('prefers sessionStorage over localStorage', () => {
    localStorage.setItem('currentKbId', 'kbase_from_local');
    sessionStorage.setItem('sessionKbId', 'kbase_from_session');
    expect(getCurrentKbId()).toBe('kbase_from_session');
  });
});

// ── findKbByStableId ──────────────────────────────────────────────────────────

describe('findKbByStableId', () => {
  it('returns undefined for an unknown stable ID', () => {
    expect(findKbByStableId('urn:uuid:does-not-exist')).toBeUndefined();
  });

  it('returns undefined when no stable IDs are registered', () => {
    mkKb('No Stable ID');
    expect(findKbByStableId('any-id')).toBeUndefined();
  });
});

// ── registerStableId ──────────────────────────────────────────────────────────

describe('registerStableId', () => {
  it('attaches a stable ID to an existing KB entry', () => {
    const entry = mkKb('With Stable ID');
    registerStableId(entry.id, 'urn:uuid:abc-123');
    const found = getRegistry().find((k) => k.id === entry.id);
    expect(found?.stableId).toBe('urn:uuid:abc-123');
  });

  it('allows findKbByStableId to locate the entry after registration', () => {
    const entry = mkKb('Locatable');
    registerStableId(entry.id, 'urn:uuid:locatable-99');
    const found = findKbByStableId('urn:uuid:locatable-99');
    expect(found).toBeDefined();
    expect(found?.id).toBe(entry.id);
    expect(found?.name).toBe('Locatable');
  });

  it('optionally stores a statement count', () => {
    const entry = mkKb('With Count');
    registerStableId(entry.id, 'urn:uuid:count-test', 42);
    const found = getRegistry().find((k) => k.id === entry.id);
    expect(found?.statementCount).toBe(42);
  });

  it('does nothing for an unknown dbName', () => {
    expect(() => registerStableId('nonexistent', 'urn:uuid:x')).not.toThrow();
    expect(findKbByStableId('urn:uuid:x')).toBeUndefined();
  });

  it('overwrites a previously registered stable ID', () => {
    const entry = mkKb('Update Stable');
    registerStableId(entry.id, 'urn:uuid:old');
    registerStableId(entry.id, 'urn:uuid:new');
    expect(findKbByStableId('urn:uuid:new')?.id).toBe(entry.id);
    expect(findKbByStableId('urn:uuid:old')).toBeUndefined();
  });
});

// ── updateKbEntry ─────────────────────────────────────────────────────────────

describe('updateKbEntry', () => {
  it('applies a partial patch to an existing entry', () => {
    const entry = mkKb('Patch Target');
    updateKbEntry(entry.id, { description: 'A test KB', color: '#ff0000' });
    const found = getRegistry().find((k) => k.id === entry.id);
    expect(found?.description).toBe('A test KB');
    expect(found?.color).toBe('#ff0000');
  });

  it('does not overwrite fields not included in the patch', () => {
    const entry = mkKb('Partial Patch');
    updateKbEntry(entry.id, { description: 'Only desc' });
    const found = getRegistry().find((k) => k.id === entry.id);
    expect(found?.name).toBe('Partial Patch');
  });

  it('does nothing for an unknown ID', () => {
    expect(() => updateKbEntry('no-such-id', { description: 'ghost' })).not.toThrow();
  });
});

// ── toggleBookmark ────────────────────────────────────────────────────────────

describe('toggleBookmark', () => {
  it('bookmarks an unbookmarked entry and returns true', () => {
    const entry = mkKb('Bookmark Me');
    const result = toggleBookmark(entry.id);
    expect(result).toBe(true);
    expect(getRegistry().find((k) => k.id === entry.id)?.bookmarked).toBe(true);
  });

  it('unbookmarks a bookmarked entry and returns false', () => {
    const entry = mkKb('Unbookmark Me');
    toggleBookmark(entry.id);  // on
    const result = toggleBookmark(entry.id); // off
    expect(result).toBe(false);
    expect(getRegistry().find((k) => k.id === entry.id)?.bookmarked).toBe(false);
  });

  it('returns false for an unknown ID', () => {
    expect(toggleBookmark('ghost-id')).toBe(false);
  });
});

// ── getBookmarkedKbs ──────────────────────────────────────────────────────────

describe('getBookmarkedKbs', () => {
  it('returns an empty array when nothing is bookmarked', () => {
    mkKb('Not bookmarked');
    expect(getBookmarkedKbs()).toHaveLength(0);
  });

  it('returns only bookmarked entries', () => {
    const a = mkKb('Star A');
    const b = mkKb('Star B');
    mkKb('No Star C');
    toggleBookmark(a.id);
    toggleBookmark(b.id);
    const bookmarked = getBookmarkedKbs();
    expect(bookmarked).toHaveLength(2);
    expect(bookmarked.map((k) => k.id)).toContain(a.id);
    expect(bookmarked.map((k) => k.id)).toContain(b.id);
  });
});

// ── kbUrl ─────────────────────────────────────────────────────────────────────

describe('kbUrl', () => {
  it('returns the path unchanged for the default KB', () => {
    expect(kbUrl(DEFAULT_ID)).toBe('/');
    expect(kbUrl(DEFAULT_ID, '/review')).toBe('/review');
  });

  it('appends ?kb= for a non-default KB', () => {
    expect(kbUrl('kbase_42')).toBe('/?kb=kbase_42');
  });

  it('uses & when the path already has a query string', () => {
    expect(kbUrl('kbase_42', '/review?tab=align')).toBe('/review?tab=align&kb=kbase_42');
  });
});
