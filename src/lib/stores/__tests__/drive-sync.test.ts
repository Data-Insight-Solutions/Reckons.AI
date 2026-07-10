/**
 * Tests for Google Drive folder sync (drive-sync.svelte.ts) against an in-memory
 * fake Drive: push uploads every KB, pull imports new / updates existing graphs,
 * and the content-hash loop guard stops a just-pushed file being re-pulled.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── In-memory fake Drive ─────────────────────────────────────────────────────
const drive = new Map<string, { id: string; content: string }>();
let folderSeq = 0;

vi.mock('../../integrations/google/drive', () => ({
  ensureFolder: vi.fn(async () => 'folder-1'),
  listFolderTurtles: vi.fn(async () =>
    [...drive.entries()].map(([name, f]) => ({ id: f.id, name, modifiedTime: '', size: '1' }))
  ),
  uploadTurtleToFolder: vi.fn(async (filename: string, content: string, _fid: string, existingId?: string) => {
    const id = existingId ?? `file-${++folderSeq}`;
    drive.set(filename, { id, content });
    return id;
  }),
  downloadFile: vi.fn(async (fileId: string) => {
    for (const f of drive.values()) if (f.id === fileId) return f.content;
    throw new Error('not found');
  }),
}));

vi.mock('../../integrations/google/auth', () => ({ ensureAuth: vi.fn(async () => {}) }));

let clientId = 'client-123';
vi.mock('../settings.svelte', () => ({ settings: () => ({ googleClientId: clientId }) }));

let registry: { id: string; name: string; stableId?: string; createdAt: number }[] = [];
vi.mock('../../storage/kb-registry', () => ({
  getRegistry: () => registry,
  getCurrentKbId: () => 'kbase',
}));

// serializeKb reads statements from a KBaseDB and runs toTurtle.
vi.mock('../../storage/db', () => {
  class FakeDB {
    name: string;
    statements = { toArray: async () => [{ id: 's1' }, { id: 's2' }] };
    constructor(name = 'kbase') { this.name = name; }
    async open() { return this; }
    close() {}
  }
  return { db: new FakeDB('kbase'), KBaseDB: FakeDB };
});
vi.mock('../../rdf/serialize', () => ({ toTurtle: (s: unknown[]) => `# graph with ${s.length} statements\n` }));
vi.mock('../kb.svelte', () => ({ loadAll: vi.fn(async () => {}) }));

const ingestNewKb = vi.fn(async () => ({ kbId: 'new-kb', count: 2 }));
const ingestExistingKb = vi.fn(async () => 2);
vi.mock('../kb-import', () => ({ ingestNewKb, ingestExistingKb }));

beforeEach(() => {
  vi.resetModules();
  drive.clear();
  folderSeq = 0;
  registry = [];
  clientId = 'client-123';
  ingestNewKb.mockClear();
  ingestExistingKb.mockClear();
  (globalThis as any).localStorage ??= {
    _s: new Map<string, string>(),
    getItem(k: string) { return this._s.get(k) ?? null; },
    setItem(k: string, v: string) { this._s.set(k, v); },
    removeItem(k: string) { this._s.delete(k); },
  };
});

describe('drive-sync', () => {
  it('does not link without a Google client id', async () => {
    clientId = '';
    const m = await import('../drive-sync.svelte');
    expect(await m.linkDriveFolder()).toBe(false);
    expect(m.driveLinked()).toBe(false);
  });

  it('links a Drive folder', async () => {
    const m = await import('../drive-sync.svelte');
    expect(await m.linkDriveFolder('My Graphs')).toBe(true);
    expect(m.driveLinked()).toBe(true);
    expect(m.driveFolderName()).toBe('My Graphs');
  });

  it('pushes every registered KB as a .ttl', async () => {
    registry = [
      { id: 'kbase', name: 'Default Graph', createdAt: 0 },
      { id: 'kb_2', name: 'Trip Plan', createdAt: 0 },
    ];
    const m = await import('../drive-sync.svelte');
    await m.linkDriveFolder();
    const pushed = await m.driveSyncPush();
    expect(pushed).toBe(2);
    expect([...drive.keys()].sort()).toEqual(['default-graph.ttl', 'trip-plan.ttl']);
  });

  it('pull imports a new graph and updates an existing one', async () => {
    registry = [{ id: 'kb_notes', name: 'notes', createdAt: 0 }];
    drive.set('notes.ttl', { id: 'file-a', content: '# notes v2\n' });     // matches existing → update
    drive.set('fresh.ttl', { id: 'file-b', content: '# brand new\n' });     // no match → import
    const m = await import('../drive-sync.svelte');
    await m.linkDriveFolder();
    const { imported, updated } = await m.driveSyncPull();
    expect(updated).toContain('notes');
    expect(imported).toContain('fresh');
    expect(ingestExistingKb).toHaveBeenCalledTimes(1);
    expect(ingestNewKb).toHaveBeenCalledTimes(1);
  });

  it('auto-sync off: a scheduled push is a no-op', async () => {
    vi.useFakeTimers();
    localStorage.setItem('reckons:drive-autosync', 'false');
    registry = [{ id: 'kbase', name: 'g', createdAt: 0 }];
    const m = await import('../drive-sync.svelte');
    await m.linkDriveFolder();
    m.scheduleDrivePush();
    await vi.advanceTimersByTimeAsync(6000); // past the 5s debounce
    expect(drive.size).toBe(0);
    vi.useRealTimers();
  });

  it('auto-sync on: a scheduled push fires after the debounce', async () => {
    vi.useFakeTimers();
    localStorage.setItem('reckons:drive-autosync', 'true');
    registry = [{ id: 'kbase', name: 'g', createdAt: 0 }];
    const m = await import('../drive-sync.svelte');
    expect(m.driveAutoSync()).toBe(true);
    await m.linkDriveFolder();
    m.scheduleDrivePush();
    await vi.advanceTimersByTimeAsync(6000); // 5s debounce fires; 45s poll does not
    expect(drive.has('g.ttl')).toBe(true);
    m.stopDrivePolling();
    vi.useRealTimers();
  });

  it('loop guard: a just-pushed file is not re-imported on the next pull', async () => {
    registry = [{ id: 'kb_x', name: 'x', createdAt: 0 }];
    const m = await import('../drive-sync.svelte');
    await m.linkDriveFolder();
    await m.driveSyncPush();              // writes x.ttl + records its hash
    const r = await m.driveSyncPull();    // same content → skipped
    expect(r.imported).toHaveLength(0);
    expect(r.updated).toHaveLength(0);
    expect(ingestNewKb).not.toHaveBeenCalled();
    expect(ingestExistingKb).not.toHaveBeenCalled();
  });
});
