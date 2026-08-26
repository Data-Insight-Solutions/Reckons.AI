/**
 * The poll must drain pending, and it must not drain twice at once.
 *
 * THE BUG THIS PINS. pullFromWorkspace reads kbs/*.ttl and nothing else, so a row appended to
 * knowledge.pending.jsonl by something OUTSIDE the browser — an agent, a scheduled job, an n8n
 * workflow relaying a note dictated into a phone — arrived only on app reload or when /review
 * was opened by hand. Leave the app open on the graph view and a captured note never appears,
 * which is indistinguishable from the capture having failed. For a voice-capture flow that is
 * the whole feature silently not working.
 *
 * THE HAZARD THE FIX INTRODUCES. drainWorkspacePending READS the file, decides what it can
 * safely take, and WRITES the remainder back. The app-load and /review callers could never
 * overlap; a 10-second timer overlaps a slow IndexedDB write easily, and two concurrent runs
 * both compute a remainder without the other — importing a row twice, or dropping a row nobody
 * imported. So the guard is tested as carefully as the feature.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const addStatementsSpy = vi.fn(async () => {});
const addSourceSpy = vi.fn(async () => {});

vi.mock('../kb.svelte', () => ({
  loadAll: vi.fn(async () => {}),
  addStatements: addStatementsSpy,
  addSource: addSourceSpy,
}));
vi.mock('../settings.svelte', () => ({ updateSettings: vi.fn(async () => {}) }));
vi.mock('../../storage/kb-registry', () => ({
  getRegistry: () => [{ id: 'kbase', name: 'notes', createdAt: 0 }],
  getCurrentKbId: () => 'kbase',
  getCurrentKbName: () => 'notes',
  findKbByStableId: () => undefined,
  createKb: (name: string) => ({ id: `kb_${name}`, name, createdAt: 0 }),
  registerStableId: () => {},
}));

class FakeFileHandle {
  content = '';
  kind = 'file' as const;
  constructor(public name: string) {}
  async getFile() {
    const text = this.content;
    return { text: async () => text };
  }
  async createWritable() {
    const self = this;
    return {
      write: async (d: unknown) => { self.content = typeof d === 'string' ? d : String(d); },
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
  async *entries(): AsyncGenerator<[string, FakeDirHandle | FakeFileHandle]> {
    for (const [k, v] of this.dirs) yield [k, v];
    for (const [k, v] of this.files) yield [k, v];
  }
}

/** One well-formed pending row targeted at the active graph. */
const note = (subject: string) =>
  JSON.stringify({
    subject,
    predicate: 'urn:kbase:predicate/captured-note',
    object: 'Ask about spring market stall fees',
    kb: 'notes',
    type: 'observation',
    agent: 'ios-shortcut',
  });

let root: FakeDirHandle;

beforeEach(() => {
  vi.resetModules();
  addStatementsSpy.mockClear();
  addSourceSpy.mockClear();
  root = new FakeDirHandle('root');
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).localStorage = (globalThis as any).localStorage ?? {
    _s: new Map<string, string>(),
    getItem(k: string) { return this._s.get(k) ?? null; },
    setItem(k: string, v: string) { this._s.set(k, v); },
    removeItem(k: string) { this._s.delete(k); },
  };
});

describe('the poll drains pending', () => {
  it('imports a note that arrived in the folder while the app sat open', async () => {
    vi.useFakeTimers();
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    (await root.getFileHandle('knowledge.pending.jsonl', { create: true })).content = note('urn:kbase:concept/market');

    mod.startWorkspacePolling(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runOnlyPendingTimersAsync();
    mod.stopWorkspacePolling();
    vi.useRealTimers();

    // Nothing reloaded, nothing navigated — the note arrived on a timer tick.
    expect(addStatementsSpy).toHaveBeenCalled();
  });

  it('consumes the row, so the next tick does not import it again', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    const fh = await root.getFileHandle('knowledge.pending.jsonl', { create: true });
    fh.content = note('urn:kbase:concept/market');

    await mod.drainAndImportPending();
    expect(addStatementsSpy).toHaveBeenCalledTimes(1);

    addStatementsSpy.mockClear();
    await mod.drainAndImportPending();
    expect(addStatementsSpy).not.toHaveBeenCalled();
  });

  it('a poll cycle that throws does not kill the timer', async () => {
    // An unhandled rejection inside setInterval is invisible and leaves sync silently dead —
    // the user keeps dictating notes into a pipeline that stopped running.
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    const fh = await root.getFileHandle('knowledge.pending.jsonl', { create: true });
    fh.content = note('urn:kbase:concept/market');
    addStatementsSpy.mockRejectedValueOnce(new Error('indexeddb exploded'));

    mod.startWorkspacePolling(10_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runOnlyPendingTimersAsync();

    // Second tick still fires.
    addStatementsSpy.mockClear();
    fh.content = note('urn:kbase:concept/other');
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.runOnlyPendingTimersAsync();
    mod.stopWorkspacePolling();
    vi.useRealTimers();
    warn.mockRestore();

    expect(addStatementsSpy).toHaveBeenCalled();
  });
});

describe('concurrent drains', () => {
  it('two callers share one drain rather than racing the file', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    (await root.getFileHandle('knowledge.pending.jsonl', { create: true })).content = note('urn:kbase:concept/market');

    // The real collision: a poll tick and a /review visit landing together.
    const [a, b] = await Promise.all([mod.drainAndImportPending(), mod.drainAndImportPending()]);

    expect(addStatementsSpy).toHaveBeenCalledTimes(1);
    expect(a).toBe(b); // same run, same count — not one real drain and one empty one
  });

  it('releases the guard so a later drain still works', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    const fh = await root.getFileHandle('knowledge.pending.jsonl', { create: true });
    fh.content = note('urn:kbase:concept/market');
    await mod.drainAndImportPending();

    addStatementsSpy.mockClear();
    fh.content = note('urn:kbase:concept/second');
    await mod.drainAndImportPending();
    expect(addStatementsSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the guard even when the drain throws', async () => {
    const mod = await import('../workspace.svelte');
    mod.__linkHandleForTest(root as any);
    const fh = await root.getFileHandle('knowledge.pending.jsonl', { create: true });
    fh.content = note('urn:kbase:concept/market');
    addStatementsSpy.mockRejectedValueOnce(new Error('boom'));
    await expect(mod.drainAndImportPending()).rejects.toThrow('boom');

    // A stuck guard would wedge the pipeline permanently — every later note silently lost.
    addStatementsSpy.mockClear();
    fh.content = note('urn:kbase:concept/second');
    await mod.drainAndImportPending();
    expect(addStatementsSpy).toHaveBeenCalledTimes(1);
  });
});
