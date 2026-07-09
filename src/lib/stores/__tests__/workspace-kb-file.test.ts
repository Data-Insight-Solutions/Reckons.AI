/**
 * Tests for the `kbs/{name}/{name}.ttl` workspace file-naming convention
 * (with legacy `kbs/{name}/kb.ttl` fallback) implemented in workspace.svelte.ts.
 *
 * Uses lightweight in-memory fakes for the File System Access API
 * (FileSystemDirectoryHandle / FileSystemFileHandle) since jsdom doesn't
 * implement it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { KbEntry } from '../../storage/kb-registry';

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

  async *values(): AsyncGenerator<FakeDirHandle | FakeFileHandle> {
    for (const d of this.dirs.values()) yield d;
    for (const f of this.files.values()) yield f;
  }
}

function mkEntry(overrides: Partial<KbEntry> = {}): KbEntry {
  return { id: 'kbase_1', name: 'My KB', createdAt: Date.now(), ...overrides };
}

describe('workspace kbs/{name}/{name}.ttl convention', () => {
  let root: FakeDirHandle;

  beforeEach(async () => {
    vi.resetModules();
    root = new FakeDirHandle('root');

    // Connect the workspace by faking showDirectoryPicker + a granted permission.
    (globalThis as any).window = (globalThis as any).window ?? {};
    (window as any).showDirectoryPicker = vi.fn(async () => {
      (root as any).queryPermission = async () => 'granted';
      (root as any).requestPermission = async () => 'granted';
      return root;
    });
  });

  async function connectedWorkspace() {
    const mod = await import('../workspace.svelte');
    const ok = await mod.pickWorkspace();
    expect(ok).toBe(true);
    return mod;
  }

  it('writes the KB TTL to {folderName}.ttl, not kb.ttl', async () => {
    const mod = await connectedWorkspace();
    const entry = mkEntry({ name: 'Roadmap' });

    await mod.writeKbToFolder(entry, '<a> <b> <c> .', undefined, []);

    const kbsDir = await root.getDirectoryHandle('kbs');
    const kbDir = await kbsDir.getDirectoryHandle('roadmap');
    expect(kbDir.files.has('roadmap.ttl')).toBe(true);
    expect(kbDir.files.has('kb.ttl')).toBe(false);
  });

  it('listKbFolders discovers a KB via the named file', async () => {
    const mod = await connectedWorkspace();
    const kbsDir = await root.getDirectoryHandle('kbs', { create: true });
    const kbDir = await kbsDir.getDirectoryHandle('roadmap', { create: true });
    const fh = await kbDir.getFileHandle('roadmap.ttl', { create: true });
    fh.content = '<a> <b> <c> .';

    const folders = await mod.listKbFolders();
    expect(folders.map(f => f.folderName)).toContain('roadmap');
  });

  it('listKbFolders falls back to legacy kb.ttl when the named file is absent', async () => {
    const mod = await connectedWorkspace();
    const kbsDir = await root.getDirectoryHandle('kbs', { create: true });
    const kbDir = await kbsDir.getDirectoryHandle('legacy-kb', { create: true });
    const fh = await kbDir.getFileHandle('kb.ttl', { create: true });
    fh.content = '<a> <b> <c> .';

    const folders = await mod.listKbFolders();
    expect(folders.map(f => f.folderName)).toContain('legacy-kb');
  });

  it('listKbFolders discovers a loose .ttl at the workspace root', async () => {
    const mod = await connectedWorkspace();
    const fh = await root.getFileHandle('visual-tests.ttl', { create: true });
    fh.content = '<a> <b> <c> .';

    const folders = await mod.listKbFolders();
    const vt = folders.find(f => f.folderName === 'visual-tests');
    expect(vt).toBeTruthy();
    expect(vt!.path).toEqual(['visual-tests.ttl']);
  });

  it('listKbFolders discovers a .ttl in any nested directory', async () => {
    const mod = await connectedWorkspace();
    const sub = await root.getDirectoryHandle('reports', { create: true });
    const deep = await sub.getDirectoryHandle('2026', { create: true });
    (await deep.getFileHandle('run.ttl', { create: true })).content = '<a> <b> <c> .';

    const folders = await mod.listKbFolders();
    const run = folders.find(f => f.folderName === 'run');
    expect(run).toBeTruthy();
    expect(run!.path).toEqual(['reports', '2026', 'run.ttl']);
    expect(await mod.readTtlByPath(run!.path)).toBe('<a> <b> <c> .');
  });

  it('listKbFolders skips node_modules, build, and hidden dirs (real repo root)', async () => {
    const mod = await connectedWorkspace();
    // A real KB the user wants.
    (await (await root.getDirectoryHandle('static', { create: true }))
      .getFileHandle('roadmap.ttl', { create: true })).content = '<a> <b> <c> .';
    // Junk .ttl that must NOT be imported.
    for (const dir of ['node_modules', 'build', '.git', '.svelte-kit']) {
      (await (await root.getDirectoryHandle(dir, { create: true }))
        .getFileHandle('stray.ttl', { create: true })).content = '<x> <y> <z> .';
    }

    const folders = await mod.listKbFolders();
    const names = folders.map(f => f.folderName);
    expect(names).toContain('roadmap');
    expect(names).not.toContain('stray');
    expect(folders.every(f => !f.path.some(seg => ['node_modules', 'build', '.git', '.svelte-kit'].includes(seg)))).toBe(true);
  });

  it('listKbFolders drops legacy kb.ttl when a named sibling exists (no dup)', async () => {
    const mod = await connectedWorkspace();
    const kbsDir = await root.getDirectoryHandle('kbs', { create: true });
    const kbDir = await kbsDir.getDirectoryHandle('dup', { create: true });
    (await kbDir.getFileHandle('dup.ttl', { create: true })).content = '<x> <y> <z> .';
    (await kbDir.getFileHandle('kb.ttl', { create: true })).content = '<x> <y> <z> .';

    const folders = await mod.listKbFolders();
    expect(folders.filter(f => f.folderName === 'dup')).toHaveLength(1);
  });

  it('readKbFromFolder prefers the named file when both exist', async () => {
    const mod = await connectedWorkspace();
    const kbsDir = await root.getDirectoryHandle('kbs', { create: true });
    const kbDir = await kbsDir.getDirectoryHandle('both', { create: true });
    const named = await kbDir.getFileHandle('both.ttl', { create: true });
    named.content = '<named> <a> <b> .';
    const legacy = await kbDir.getFileHandle('kb.ttl', { create: true });
    legacy.content = '<legacy> <a> <b> .';

    const data = await mod.readKbFromFolder('both');
    expect(data?.ttl).toBe('<named> <a> <b> .');
  });

  it('readKbFromFolder falls back to kb.ttl when no named file exists', async () => {
    const mod = await connectedWorkspace();
    const kbsDir = await root.getDirectoryHandle('kbs', { create: true });
    const kbDir = await kbsDir.getDirectoryHandle('legacy-only', { create: true });
    const legacy = await kbDir.getFileHandle('kb.ttl', { create: true });
    legacy.content = '<legacy> <a> <b> .';

    const data = await mod.readKbFromFolder('legacy-only');
    expect(data?.ttl).toBe('<legacy> <a> <b> .');
  });
  it('skips the MCP knowledge.ttl export at root', async () => {
    const mod = await connectedWorkspace();
    (await root.getFileHandle('knowledge.ttl', { create: true })).content = '<a> <b> <c> .';
    (await root.getFileHandle('my-graph.ttl', { create: true })).content = '<a> <b> <c> .';
    const folders = await mod.listKbFolders();
    expect(folders.map(f => f.folderName)).toContain('my-graph');
    expect(folders.map(f => f.folderName)).not.toContain('knowledge');
  });
});
