import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceRow } from '../db';

// The module constructs a Dexie instance at import time, which needs IndexedDB. The migration
// logic itself is injectable, so stub the database and exercise the logic with in-memory stores.
vi.mock('dexie', () => {
  class FakeDexie {
    constructor(_name: string) {}
    version() { return { stores: () => {} }; }
  }
  return { default: FakeDexie, Dexie: FakeDexie };
});

const { getWorkspaceRow, putWorkspaceRow, clearWorkspaceRow } = await import('../app-db');

const handle = { name: 'reckons-workspace' } as unknown as FileSystemDirectoryHandle;

function store(seed?: WorkspaceRow) {
  const map = new Map<string, WorkspaceRow>();
  if (seed) map.set(seed.id, seed);
  return {
    map,
    get: async (k: string) => map.get(k),
    put: async (r: WorkspaceRow) => { map.set(r.id, r); },
    delete: async (k: string) => { map.delete(k); },
  };
}

const legacyRow: WorkspaceRow = { id: 'main', handle, name: 'reckons-workspace' };

describe('workspace handle is app-level, not per-graph', () => {
  it('adopts a handle left in a graph database by an older version', async () => {
    const shared = store();
    const legacy = store(legacyRow);

    const row = await getWorkspaceRow(legacy, shared);

    expect(row?.name).toBe('reckons-workspace');
    // Promoted, so the NEXT graph finds it without the user picking again.
    expect(shared.map.get('main')?.name).toBe('reckons-workspace');
  });

  it('a graph with no legacy handle of its own still sees the shared one', async () => {
    // This is the reported bug: a NEWLY CREATED graph has an empty database, so before the fix
    // there was nothing to find and the folder had to be re-picked.
    const shared = store(legacyRow);
    const freshGraph = store();

    const row = await getWorkspaceRow(freshGraph, shared);

    expect(row?.name).toBe('reckons-workspace');
  });

  it('prefers the shared row and does not re-read a stale per-graph copy', async () => {
    const shared = store({ id: 'main', handle, name: 'current-folder' });
    const legacy = store({ id: 'main', handle, name: 'stale-folder' });

    const row = await getWorkspaceRow(legacy, shared);

    expect(row?.name).toBe('current-folder');
  });

  it('reports nothing when neither store has a handle', async () => {
    expect(await getWorkspaceRow(store(), store())).toBeUndefined();
  });

  it('works with no legacy store at all', async () => {
    expect(await getWorkspaceRow(undefined, store(legacyRow))).toBeDefined();
    expect(await getWorkspaceRow(undefined, store())).toBeUndefined();
  });

  it('writes the picked folder to the shared store', async () => {
    const shared = store();
    await putWorkspaceRow(handle, 'reckons-workspace', shared);
    expect(shared.map.get('main')?.name).toBe('reckons-workspace');
  });

  it('adopts from the DEFAULT graph when the graph you opened has no handle', async () => {
    // The reported re-pick: a graph created moments ago has an empty database, so adopting only
    // from the current graph still made the user pick the folder one more time.
    const shared = store();
    const brandNewGraph = store();
    const defaultGraph = store(legacyRow);

    const row = await getWorkspaceRow([brandNewGraph, defaultGraph], shared);

    expect(row?.name).toBe('reckons-workspace');
    expect(shared.map.get('main')?.name).toBe('reckons-workspace');
  });

  it('skips a candidate database that will not open', async () => {
    const unopenable = {
      get: async () => { throw new Error('VersionError'); },
      put: async () => {},
      delete: async () => {},
    };
    const shared = store();
    const row = await getWorkspaceRow([unopenable, store(legacyRow)], shared);
    expect(row?.name).toBe('reckons-workspace');
  });

  it('disconnecting clears every legacy copy, not just the first', async () => {
    const shared = store(legacyRow);
    const a = store(legacyRow);
    const b = store(legacyRow);

    await clearWorkspaceRow([a, b], shared);

    expect(shared.map.size).toBe(0);
    expect(a.map.size).toBe(0);
    expect(b.map.size).toBe(0);
  });

  it('degrades to per-graph storage when the app database is unavailable', async () => {
    // Blocked storage or a private window must not break the workspace outright — re-picking a
    // folder is an annoyance, losing the data path is not.
    const broken = {
      get: async () => { throw new Error('storage blocked'); },
      put: async () => { throw new Error('storage blocked'); },
      delete: async () => { throw new Error('storage blocked'); },
    };
    const legacy = store(legacyRow);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect((await getWorkspaceRow(legacy, broken))?.name).toBe('reckons-workspace');

    const fallbackTarget = store();
    await putWorkspaceRow(handle, 'picked-folder', fallbackTarget, broken);
    expect(fallbackTarget.map.get('main')?.name).toBe('picked-folder');
  });

  it('disconnecting clears the legacy copy too, so it cannot silently reconnect', async () => {
    const shared = store(legacyRow);
    const legacy = store(legacyRow);

    await clearWorkspaceRow(legacy, shared);

    expect(shared.map.size).toBe(0);
    expect(legacy.map.size).toBe(0);
    expect(await getWorkspaceRow(legacy, shared)).toBeUndefined();
  });
});
