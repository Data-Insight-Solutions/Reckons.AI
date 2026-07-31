/**
 * Tests for reviewed source reference copies (F122 phase 1) in workspace.svelte.ts.
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

describe('workspace source reference copies (F122)', () => {
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

  async function connectedWorkspace() {
    const mod = await import('../workspace.svelte');
    expect(await mod.pickWorkspace()).toBe(true);
    return mod;
  }

  it('round-trips a baseline through sources/', async () => {
    const ws = await connectedWorkspace();
    const written = await ws.writeSourceBaseline('src-1', 'the reviewed article text', 4242);
    expect(written?.text).toBe('the reviewed article text');

    const read = await ws.readSourceBaseline('src-1');
    expect(read).not.toBeNull();
    expect(read!.sourceId).toBe('src-1');
    expect(read!.text).toBe('the reviewed article text');
    expect(read!.reviewedAt).toBe(4242);
    expect(read!.hash).toBe(written!.hash);
  });

  it('writes into sources/ and nowhere else', async () => {
    const ws = await connectedWorkspace();
    await ws.writeSourceBaseline('src-1', 'body', 1);
    expect(root.dirs.has(ws.SOURCES_DIR)).toBe(true);
    expect([...root.dirs.get(ws.SOURCES_DIR)!.files.keys()]).toEqual(['src-1.json']);
  });

  it('keeps ONE slot per source — a second write overwrites rather than accruing history', async () => {
    const ws = await connectedWorkspace();
    await ws.writeSourceBaseline('src-1', 'version one', 1);
    await ws.writeSourceBaseline('src-1', 'version two', 2);

    expect(root.dirs.get(ws.SOURCES_DIR)!.files.size).toBe(1);
    const read = await ws.readSourceBaseline('src-1');
    expect(read!.text).toBe('version two');
  });

  it('reports no baseline for an unknown source instead of throwing', async () => {
    const ws = await connectedWorkspace();
    expect(await ws.readSourceBaseline('never-seen')).toBeNull();
    expect((await ws.classifySourceChange('never-seen', 'anything')).reason).toBe('no-baseline');
  });

  it('short-circuits an unchanged source and flags a changed one', async () => {
    const ws = await connectedWorkspace();
    await ws.writeSourceBaseline('src-1', 'a post that has not changed', 1);

    const same = await ws.classifySourceChange('src-1', 'a post that has not changed');
    expect(same.changed).toBe(false);
    expect(same.reason).toBe('unchanged');

    const moved = await ws.classifySourceChange('src-1', 'a post that HAS changed');
    expect(moved.changed).toBe(true);
    expect(moved.reason).toBe('changed');
    expect(moved.canDiffText).toBe(true);
  });

  it('does not retain a document the content policy blocks', async () => {
    const ws = await connectedWorkspace();
    const { classifyText } = await import('../../safety/content-policy');

    // Find real blocked text rather than asserting against a hand-made string, so this test
    // fails loudly if the policy stops covering the category rather than passing vacuously.
    const blocked = 'how to make a bioweapon';
    expect(classifyText(blocked).rating).toBe('blocked');

    expect(await ws.writeSourceBaseline('src-blocked', blocked, 1)).toBeNull();
    expect(await ws.readSourceBaseline('src-blocked')).toBeNull();
    expect(root.dirs.has(ws.SOURCES_DIR)).toBe(false);
  });

  it('removes a baseline on unsubscribe, and removing twice is not an error', async () => {
    const ws = await connectedWorkspace();
    await ws.writeSourceBaseline('src-1', 'body', 1);
    await ws.removeSourceBaseline('src-1');
    expect(await ws.readSourceBaseline('src-1')).toBeNull();
    await expect(ws.removeSourceBaseline('src-1')).resolves.toBeUndefined();
  });

  it('sanitizes a hostile source id rather than escaping the sources/ directory', async () => {
    const ws = await connectedWorkspace();
    await ws.writeSourceBaseline('../../etc/passwd', 'body', 1);
    const names = [...root.dirs.get(ws.SOURCES_DIR)!.files.keys()];
    expect(names).toHaveLength(1);
    expect(names[0]).not.toContain('/');
    expect(names[0]).not.toContain('..');
    // And it still round-trips under the same sanitized name.
    expect((await ws.readSourceBaseline('../../etc/passwd'))!.text).toBe('body');
  });

  it('does not collapse two distinct awkward ids onto one baseline file', async () => {
    const ws = await connectedWorkspace();
    await ws.writeSourceBaseline('a/b', 'from a-slash-b', 1);
    await ws.writeSourceBaseline('a.b', 'from a-dot-b', 1);

    expect(root.dirs.get(ws.SOURCES_DIR)!.files.size).toBe(2);
    expect((await ws.readSourceBaseline('a/b'))!.text).toBe('from a-slash-b');
    expect((await ws.readSourceBaseline('a.b'))!.text).toBe('from a-dot-b');
  });

  it('treats a corrupt or hand-edited baseline file as no baseline', async () => {
    const ws = await connectedWorkspace();
    await ws.writeSourceBaseline('src-1', 'body', 1);
    root.dirs.get(ws.SOURCES_DIR)!.files.get('src-1.json')!.content = '{ not json';
    expect(await ws.readSourceBaseline('src-1')).toBeNull();

    root.dirs.get(ws.SOURCES_DIR)!.files.get('src-1.json')!.content = JSON.stringify({ nope: true });
    expect(await ws.readSourceBaseline('src-1')).toBeNull();
  });

  it('degrades to "no baseline" with no workspace connected, rather than failing', async () => {
    vi.resetModules();
    const ws = await import('../workspace.svelte');
    expect(await ws.writeSourceBaseline('src-1', 'body', 1)).toBeNull();
    expect(await ws.readSourceBaseline('src-1')).toBeNull();
    expect((await ws.classifySourceChange('src-1', 'body')).reason).toBe('no-baseline');
  });
});
