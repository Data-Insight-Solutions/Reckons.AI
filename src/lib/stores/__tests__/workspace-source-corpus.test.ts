/**
 * Tests for the source corpus boundary (F221): sources/ is never walked as a graph, and the
 * fs adapter round-trips through a fake directory handle.
 *
 * Uses the same in-memory File System Access API fakes as workspace-kb-file.test.ts, since
 * jsdom implements none of it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mocks for modules workspace.svelte.ts pulls in but that we don't need here ──

vi.mock('../../storage/db', () => ({
  db: {
    workspace: { get: vi.fn(async () => null), put: vi.fn(async () => {}) },
    statements: { toArray: vi.fn(async () => []) },
    settings: { get: vi.fn(async () => undefined) },
  },
  KBaseDB: class {},
}));

vi.mock('../settings.svelte', () => ({
  updateSettings: vi.fn(async () => {}),
}));

vi.mock('../../storage/kb-registry', () => ({
  getRegistry: vi.fn(() => []),
}));

vi.mock('../../storage/kb-assets', () => ({
  collectAssets: vi.fn(async () => []),
  assetTriples: vi.fn(async () => ''),
}));

// ── In-memory fake File System Access API ───────────────────────────────────

class FakeFileHandle {
  content = '';
  kind = 'file' as const;
  constructor(public name: string) {}
  async getFile() {
    const text = this.content;
    return {
      text: async () => text,
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    };
  }
  async createWritable() {
    const self = this;
    return {
      write: async (data: unknown) => {
        self.content = typeof data === 'string' ? data : new TextDecoder().decode(data as ArrayBuffer);
      },
      close: async () => {},
    };
  }
}

class FakeDirHandle {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
  constructor(public name: string) {}

  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDirHandle> {
    if (!this.dirs.has(name)) {
      if (opts?.create) this.dirs.set(name, new FakeDirHandle(name));
      else throw new Error(`directory not found: ${name}`);
    }
    return this.dirs.get(name)!;
  }

  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    if (!this.files.has(name)) {
      if (opts?.create) this.files.set(name, new FakeFileHandle(name));
      else throw new Error(`file not found: ${name}`);
    }
    return this.files.get(name)!;
  }

  async removeEntry(name: string): Promise<void> {
    if (!this.files.delete(name) && !this.dirs.delete(name)) throw new Error(`not found: ${name}`);
  }

  async *values(): AsyncGenerator<FakeDirHandle | FakeFileHandle> {
    for (const d of this.dirs.values()) yield d;
    for (const f of this.files.values()) yield f;
  }
}

describe('source corpus (F221) boundary', () => {
  let root: FakeDirHandle;

  beforeEach(async () => {
    vi.resetModules();
    root = new FakeDirHandle('root');
    (globalThis as any).window = (globalThis as any).window ?? {};
    (window as any).showDirectoryPicker = vi.fn(async () => {
      (root as any).queryPermission = async () => 'granted';
      (root as any).requestPermission = async () => 'granted';
      return root;
    });
  });

  it('retains through the fs adapter and reads back, in sources/<slug>-<hash8>/', async () => {
    const ws = await import('../workspace.svelte');
    expect(await ws.pickWorkspace()).toBe(true);
    const { fsCorpusRoot } = await import('../../storage/source-corpus-fs');
    const { retainSource, readRetainedText } = await import('../../ingest/source-corpus');
    const corpus = fsCorpusRoot(ws.workspaceHandle()!);
    const r = await retainSource(corpus, { sourceId: 's1', title: 'Tide Tables', hash: '0123456789abcdef', text: 'High tide at noon.' });
    expect(r.status).toBe('retained');
    const dir = root.dirs.get('sources')!.dirs.get('tide-tables-01234567')!;
    expect([...dir.files.keys()].sort()).toEqual(['chunks.ttl', 'text.md']);
    expect(await readRetainedText(corpus, '0123456789abcdef')).toBe('High tide at noon.');
  });

  it('a chunks.ttl under sources/ is never discovered as a graph (never enters the statement store)', async () => {
    const ws = await import('../workspace.svelte');
    expect(await ws.pickWorkspace()).toBe(true);
    const { fsCorpusRoot } = await import('../../storage/source-corpus-fs');
    const { retainSource } = await import('../../ingest/source-corpus');
    await retainSource(fsCorpusRoot(ws.workspaceHandle()!), { sourceId: 's1', title: 'Tide Tables', hash: '0123456789abcdef', text: 'High tide at noon.' });
    // A real graph beside it must still be found, so the test cannot pass by finding nothing.
    const kbs = await root.getDirectoryHandle('kbs', { create: true });
    const kb = await kbs.getDirectoryHandle('harbor', { create: true });
    (await kb.getFileHandle('harbor.ttl', { create: true })).content = '<a> <b> <c> .';
    const names = (await ws.listKbFolders()).map((f) => f.folderName);
    expect(names).toContain('harbor');
    expect(names).not.toContain('chunks');
    expect(names.length).toBe(1);
  });
});
