/**
 * Tests for two-way folder sync in workspace.svelte.ts — the PULL path added
 * alongside the existing push: pollFromWorkspace imports new `.ttl`, updates a
 * KB whose file changed on disk, and (loop guard) never re-imports a file the
 * app itself just wrote.
 *
 * Uses in-memory fakes for the File System Access API and for the Dexie/registry
 * modules workspace.svelte.ts pulls in.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { KbEntry } from '../../storage/kb-registry';

// ── Mutable fakes shared across the mocked modules ───────────────────────────

let registry: KbEntry[] = [];
const loadAllSpy = vi.fn(async () => {});
let currentKbId = 'kbase';

class FakeTable {
  rows = new Map<string, any>();
  async toArray() { return [...this.rows.values()]; }
  async put(r: any) { this.rows.set(r.id, r); }
  async bulkPut(rs: any[]) { for (const r of rs) this.rows.set(r.id, r); }
  async bulkDelete(ks: string[]) { for (const k of ks) this.rows.delete(k); }
  async delete(k: string) { this.rows.delete(k); }
  async clear() { this.rows.clear(); }
  async get(k: string) { return this.rows.get(k); }
  async update(k: string, patch: any) { const r = this.rows.get(k); if (r) this.rows.set(k, { ...r, ...patch }); }
  where(field: string) {
    return { equals: (v: any) => ({ toArray: async () => [...this.rows.values()].filter((r) => r[field] === v) }) };
  }
}
class FakeDB {
  name: string;
  statements = new FakeTable();
  sources = new FakeTable();
  settings = new FakeTable();
  entityGifs = new FakeTable();
  glbOverrides = new FakeTable();
  icon2dOverrides = new FakeTable();
  workspace = new FakeTable();
  kbSnapshots = new FakeTable();
  constructor(name = 'kbase') { this.name = name; }
  async open() { return this; }
  close() {}
  // Passthrough: the real Dexie transaction gives atomicity; the fake just runs the body.
  async transaction(_mode: string, _tables: unknown, cb: () => Promise<unknown>) { return cb(); }
}
const fakeDb = new FakeDB('kbase');

vi.mock('../../storage/db', () => ({
  db: fakeDb,
  KBaseDB: class { constructor(name?: string) { return new FakeDB(name); } },
  DEFAULT_SETTINGS: { key: 'main' },
}));

vi.mock('../settings.svelte', () => ({ updateSettings: vi.fn(async () => {}) }));

vi.mock('../kb.svelte', () => ({ loadAll: loadAllSpy }));

vi.mock('../../storage/kb-registry', () => ({
  getRegistry: () => registry,
  getCurrentKbId: () => currentKbId,
  findKbByStableId: (sid: string) => registry.find(r => r.stableId === sid),
  createKb: (name: string) => { const e = { id: `kb_${name}`, name, createdAt: 0 }; registry.push(e); return e; },
  registerStableId: (id: string, sid: string) => { const e = registry.find(r => r.id === id); if (e) e.stableId = sid; },
}));

vi.mock('../../storage/kb-assets', () => ({
  collectAssets: vi.fn(async () => []),
  assetTriples: vi.fn(async () => ''),
  parseAssetRefs: () => [],
  isAssetPath: () => false,
  extToMime: () => 'image/png',
}));

// importTurtleFull → one confirmed statement per " ." terminator in the text. `cleanImportCount:
// 0` marks this as an annotated (lossless) import, so populateKbFromTtl preserves the statements
// verbatim rather than coercing them.
vi.mock('../../rdf/import-ttl', () => ({
  importTurtleFull: async (ttl: string) => ({
    statements: (ttl.match(/\./g) ?? []).map((_, i) => ({
      id: `s${i}`,
      s: { kind: 'iri', value: `urn:s${i}` },
      p: { kind: 'iri', value: 'urn:p' },
      o: { kind: 'literal', value: `v${i}`, datatype: null, lang: null },
      status: 'confirmed',
    })),
    sources: [],
    cleanImportCount: 0,
  }),
}));

vi.mock('../../rdf/serialize', () => ({
  toTurtle: () => '<a> <b> <c> .',
  toTurtleFull: () => '<a> <b> <c> .',
}));

// ── Fake File System Access API ──────────────────────────────────────────────

class FakeFileHandle {
  content = '';
  kind = 'file' as const;
  constructor(public name: string) {}
  async getFile() {
    const text = this.content;
    return { text: async () => text, arrayBuffer: async () => new TextEncoder().encode(text).buffer };
  }
  async createWritable() {
    const self = this;
    return {
      write: async (d: unknown) => { self.content = typeof d === 'string' ? d : new TextDecoder().decode(d as ArrayBuffer); },
      close: async () => {},
    };
  }
}
class FakeDirHandle {
  kind = 'directory' as const;
  dirs = new Map<string, FakeDirHandle>();
  files = new Map<string, FakeFileHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
    if (!this.dirs.has(name)) {
      if (opts?.create) this.dirs.set(name, new FakeDirHandle(name));
      else throw new Error(`no dir ${name}`);
    }
    return this.dirs.get(name)!;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }) {
    if (!this.files.has(name)) {
      if (opts?.create) this.files.set(name, new FakeFileHandle(name));
      else throw new Error(`no file ${name}`);
    }
    return this.files.get(name)!;
  }
  async *values() { for (const d of this.dirs.values()) yield d; for (const f of this.files.values()) yield f; }
}

function mkEntry(o: Partial<KbEntry> = {}): KbEntry {
  return { id: 'kbase', name: 'My KB', createdAt: 0, ...o };
}

async function seedFile(root: FakeDirHandle, segs: string[], content: string) {
  let dir = root;
  for (const s of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(s, { create: true });
  (await dir.getFileHandle(segs[segs.length - 1], { create: true })).content = content;
}

describe('two-way folder sync — pullFromWorkspace', () => {
  let root: FakeDirHandle;

  beforeEach(async () => {
    vi.resetModules();
    registry = [];
    currentKbId = 'kbase';
    loadAllSpy.mockClear();
    root = new FakeDirHandle('root');
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).localStorage = (globalThis as any).localStorage ?? {
      _s: new Map<string, string>(),
      getItem(k: string) { return this._s.get(k) ?? null; },
      setItem(k: string, v: string) { this._s.set(k, v); },
      removeItem(k: string) { this._s.delete(k); },
    };
    // Each test starts with a clean revision baseline. The key is scoped per graph, so ask the
    // module which key it will use rather than hardcoding one.
    {
      const { seenHashesKey } = await import('../workspace.svelte');
      (globalThis as any).localStorage.removeItem(seenHashesKey());
    }
    fakeDb.workspace.rows.clear();
  });

  it('imports a new nested .ttl as a KB', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    await seedFile(root, ['reports', '2026', 'trip.ttl'], '<a> <b> <c> .');

    const { imported, updated } = await mod.pullFromWorkspace();
    expect(imported).toContain('trip');
    expect(updated).toHaveLength(0);
    expect(registry.map(r => r.name)).toContain('trip');
  });

  it('updates an existing KB when its file changed on disk', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    // KB "notes" already registered.
    registry.push({ id: 'kb_notes', name: 'notes', createdAt: 0 });
    await seedFile(root, ['kbs', 'notes', 'notes.ttl'], '<a> <b> <c> .');

    const { imported, updated } = await mod.pullFromWorkspace();
    expect(updated).toContain('notes');
    expect(imported).toHaveLength(0);
  });

  it('loop guard: a file the app just wrote is not re-pulled', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    // Register + write via the app's own writer (records the hash).
    registry.push({ id: 'kb_mine', name: 'mine', createdAt: 0 });
    await mod.writeKbToFolder(mkEntry({ id: 'kb_mine', name: 'mine' }), '<a> <b> <c> .', undefined, []);

    const { imported, updated } = await mod.pullFromWorkspace();
    expect(imported).toHaveLength(0);
    expect(updated).toHaveLength(0);
  });

  it('a second pull with no disk change is a no-op', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    await seedFile(root, ['kbs', 'a', 'a.ttl'], '<a> <b> <c> .');

    await mod.pullFromWorkspace();               // first: imports
    const second = await mod.pullFromWorkspace(); // second: unchanged
    expect(second.imported).toHaveLength(0);
    expect(second.updated).toHaveLength(0);
  });

  it('persists last-seen revisions so a reconnect skips unchanged files (F107.4 Stage 2)', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    await seedFile(root, ['kbs', 'a', 'a.ttl'], '<a> <b> <c> .');
    await mod.pullFromWorkspace(); // imports 'a', records + persists its hash

    // Scoped per graph: the baseline for graph A must not silently satisfy graph B, which is what
    // one shared key did — every hash matched, so a second graph imported nothing and stayed empty.
    const stored = localStorage.getItem(mod.seenHashesKey());
    expect(stored).toBeTruthy();
    expect((JSON.parse(stored!) as [string, string][]).some(([k]) => k.includes('a.ttl'))).toBe(true);

    // Simulate a reload + reconnect: a fresh module instance has an empty in-memory baseline,
    // but loadWorkspace restores it from localStorage, so the unchanged file is NOT re-imported.
    vi.resetModules();
    fakeDb.workspace.rows.set('main', { id: 'main', handle: root, name: 'root' });
    const mod2 = await import('../workspace.svelte');
    await mod2.loadWorkspace();     // restores the persisted baseline
    mod2.__linkHandleForTest(root as any);

    const res = await mod2.pullFromWorkspace();
    expect(res.imported).toHaveLength(0);
    expect(res.updated).toHaveLength(0);
  });

  it('clearWorkspace forgets the persisted revision baseline', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    await seedFile(root, ['kbs', 'a', 'a.ttl'], '<a> <b> <c> .');
    await mod.pullFromWorkspace();
    expect(localStorage.getItem(mod.seenHashesKey())).toBeTruthy();

    await mod.clearWorkspace();
    expect(localStorage.getItem(mod.seenHashesKey())).toBeNull();
  });

  it('reloads the active KB store when the active KB is updated', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    currentKbId = 'kb_active';
    registry.push({ id: 'kb_active', name: 'active', createdAt: 0 });
    await seedFile(root, ['kbs', 'active', 'active.ttl'], '<a> <b> <c> .');

    await mod.pullFromWorkspace();
    expect(loadAllSpy).toHaveBeenCalled();
  });

  it('setAutoSync persists the preference', async () => {
    const mod = await import('../workspace.svelte');
    mod.setAutoSync(false);
    expect(mod.autoSyncEnabled()).toBe(false);
    expect(localStorage.getItem('reckons:ws-autosync')).toBe('false');
    mod.setAutoSync(true);
    expect(mod.autoSyncEnabled()).toBe(true);
  });

  it('pullFromWorkspace is a no-op without a linked handle', async () => {
    const mod = await import('../workspace.svelte');
    const r = await mod.pullFromWorkspace();
    expect(r).toEqual({ imported: [], updated: [] });
  });
});

describe('writeKbToFolder — holds a write it is not entitled to make', () => {
  let root: FakeDirHandle;

  beforeEach(async () => {
    vi.resetModules();
    registry = [];
    currentKbId = 'kbase';
    root = new FakeDirHandle('root');
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).localStorage = (globalThis as any).localStorage ?? {
      _s: new Map<string, string>(),
      getItem(k: string) { return this._s.get(k) ?? null; },
      setItem(k: string, v: string) { this._s.set(k, v); },
      removeItem(k: string) { this._s.delete(k); },
    };
    const { seenHashesKey } = await import('../workspace.svelte');
    (globalThis as any).localStorage.removeItem(seenHashesKey());
    fakeDb.workspace.rows.clear();
  });

  const fileAt = (segs: string[]) => {
    let dir: any = root;
    for (const s of segs.slice(0, -1)) dir = dir.dirs.get(s);
    return dir?.files.get(segs[segs.length - 1]);
  };

  it('refuses to overwrite a file it has never read — the canonical-graph clobber', () => {
    // Exactly what happened: a graph holding only freshly-drained facts wrote itself over a
    // canonical roadmap it had no baseline for.
    return (async () => {
      const mod = await import('../workspace.svelte');
      mod.__linkHandleForTest(root as any);
      await seedFile(root, ['kbs', 'my-kb', 'my-kb.ttl'], '<canonical> <graph> <content> .');

      await mod.writeKbToFolder(mkEntry(), '<our> <partial> <export> .');

      expect(fileAt(['kbs', 'my-kb', 'my-kb.ttl'])!.content).toBe('<canonical> <graph> <content> .');
      expect(mod.lastWriteHold()).toMatchObject({ held: true, reason: 'diverged' });
    })();
  });

  it('holds while a host process holds the lock sentinel', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    await seedFile(root, ['kbs', 'my-kb', 'my-kb.ttl'], 'original');
    await seedFile(root, ['kbs', 'my-kb', 'my-kb.ttl.lock'], '');

    await mod.writeKbToFolder(mkEntry(), 'ours');

    expect(fileAt(['kbs', 'my-kb', 'my-kb.ttl'])!.content).toBe('original');
    expect(mod.lastWriteHold()).toMatchObject({ held: true, reason: 'locked' });
  });

  it('writes a brand-new file, since there is nothing to clobber', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);

    await mod.writeKbToFolder(mkEntry(), '<fresh> <graph> <a> .');

    expect(fileAt(['kbs', 'my-kb', 'my-kb.ttl'])!.content).toBe('<fresh> <graph> <a> .');
    expect(mod.lastWriteHold()).toEqual({ held: false });
  });

  it('writes again over its OWN last write — the baseline still matches', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);

    await mod.writeKbToFolder(mkEntry(), 'first');
    await mod.writeKbToFolder(mkEntry(), 'second');

    expect(fileAt(['kbs', 'my-kb', 'my-kb.ttl'])!.content).toBe('second');
    expect(mod.lastWriteHold()).toEqual({ held: false });
  });

  it('holds once someone else edits the file behind us', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    await mod.writeKbToFolder(mkEntry(), 'ours-v1');

    // Claude Code / a script / git edits it out from under the app.
    fileAt(['kbs', 'my-kb', 'my-kb.ttl'])!.content = 'edited by someone else';

    await mod.writeKbToFolder(mkEntry(), 'ours-v2');

    expect(fileAt(['kbs', 'my-kb', 'my-kb.ttl'])!.content).toBe('edited by someone else');
    expect(mod.lastWriteHold()).toMatchObject({ held: true, reason: 'diverged' });
  });
});

describe('drained objects become real terms, not always literals', () => {
  it('imports a urn: object as an IRI so the fact is an EDGE, not a leaf', async () => {
    const { partitionPendingJsonl } = await import('../../rdf/pending-entry');
    const row = JSON.stringify({
      subject: 'urn:kbase:concept/a', predicate: 'urn:kbase:predicate/depends-on',
      object: 'urn:kbase:concept/b', objectKind: 'iri', kb: 'roadmap', type: 'suggestion',
    });
    const { entries } = partitionPendingJsonl(row, ['roadmap']);
    expect(entries[0].objectKind).toBe('iri');
    expect(entries[0].object).toBe('urn:kbase:concept/b');
  });
});
