/**
 * F58.9.20 (kb:scan-auto-attach), the app side: a pending row brings its splat file from the
 * folder, and a folder import that holds a splat nothing names gets a PENDING fact
 * for it. Synthetic bytes only; the fake DB stands in for IndexedDB (jsdom has none).
 */
import { describe, it, expect, vi } from 'vitest';
import type { Statement } from '../../rdf/types';

vi.mock('../../storage/db', () => ({ db: {}, KBaseDB: class {}, DEFAULT_SETTINGS: {} }));

class FakeTable {
  rows = new Map<string, any>();
  async toArray() { return [...this.rows.values()]; }
  async put(r: any) { this.rows.set(r.id, r); }
  async bulkPut(rs: any[]) { for (const r of rs) this.rows.set(r.id, r); }
  async clear() { this.rows.clear(); }
  async get(k: string) { return this.rows.get(k); }
}
class FakeDB {
  name = 'kbase';
  statements = new FakeTable(); sources = new FakeTable(); entityGifs = new FakeTable(); glbOverrides = new FakeTable();
  icon2dOverrides = new FakeTable(); kbSnapshots = new FakeTable(); splatFiles = new FakeTable();
  async transaction(_m: string, _t: unknown, cb: () => Promise<unknown>) { return cb(); }
}

const ID = '0123456789abcdef0123456789abcdef.spz';
const URL = `asset:splat/${ID}`;
const SPLAT_P = 'urn:kbase:predicate/splat';
const row = { predicate: SPLAT_P, object: URL, kb: 'demo-folder' };

describe('a pending row brings its file', () => {
  it('stores the blob from the folder when the browser lacks it', async () => {
    const { bringSplatFiles } = await import('../../storage/splat-folder');
    const database = new FakeDB();
    const read = vi.fn(async () => new Uint8Array([1, 2, 3, 4]));
    const r = await bringSplatFiles([row, { predicate: 'urn:x:other', object: 'v', kb: 'demo-folder' }], read, database as any);
    expect(r).toEqual({ stored: [ID], present: [], missing: [] });
    expect(read).toHaveBeenCalledWith('demo-folder', ID);
    const stored = database.splatFiles.rows.get(ID);
    expect(stored.size).toBe(4);
  });

  it('does nothing when the browser already has it', async () => {
    const { bringSplatFiles } = await import('../../storage/splat-folder');
    const database = new FakeDB();
    await database.splatFiles.put({ id: ID, blob: new Blob([new Uint8Array([9])]), filename: ID, size: 1, importedAt: 1 });
    const read = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const r = await bringSplatFiles([row], read, database as any);
    expect(r).toEqual({ stored: [], present: [ID], missing: [] });
    expect(read).not.toHaveBeenCalled();
    expect(database.splatFiles.rows.get(ID).size).toBe(1); // not overwritten
  });

  it('reports a file the folder lacks instead of storing nothing silently', async () => {
    const { bringSplatFiles } = await import('../../storage/splat-folder');
    const database = new FakeDB();
    const r = await bringSplatFiles([row], async () => null, database as any);
    expect(r.missing).toEqual([ID]);
    expect(database.splatFiles.rows.size).toBe(0);
  });
});

describe('a folder import that holds an unnamed splat', () => {
  it('synthesizes the splat fact as PENDING, never confirmed', async () => {
    const { populateKbFromTtl } = await import('../kb-import');
    const target = new FakeDB();
    const ttl = '<urn:kbase:concept/x> <urn:kbase:predicate/rel> <urn:kbase:concept/y> .';
    const bytes = new Uint8Array([5, 6, 7]);
    await populateKbFromTtl(target as any, 'Demo', 'workspace://demo.ttl', ttl, new Map([[`assets/splats/${ID}`, bytes], ['assets/splats/not a splat.txt', bytes]]));
    const out: Statement[] = await target.statements.toArray();
    const splat = out.find((s) => s.p.value === SPLAT_P);
    expect(splat?.o.value).toBe(URL);
    expect(splat?.status).toBe('pending');
    expect(out.filter((s) => s.s.value === splat!.s.value).every((s) => s.status === 'pending')).toBe(true);
    expect(out.find((s) => s.p.value === 'urn:kbase:predicate/rel')?.status).toBe('confirmed'); // the rest of the import is untouched
    expect(target.splatFiles.rows.has(ID)).toBe(true);
    const source = (await target.sources.toArray()).map((s: { id: string }) => s.id);
    expect(source).toContain(splat!.sourceId);
  });

  it('adds nothing when a live fact already names the file, but does when only a rejected one does', async () => {
    const { synthesizeSplatFacts } = await import('../../storage/splat-folder');
    const mk = (status: Statement['status']): Statement => ({
      id: 'a', s: { kind: 'iri', value: 'urn:kbase:concept/scan-x' }, p: { kind: 'iri', value: SPLAT_P }, o: { kind: 'literal', value: URL },
      g: { kind: 'iri', value: 'urn:kbase:source/s' }, sourceId: 's', confidence: 1, status, createdAt: 1, updatedAt: 1,
    });
    let n = 0;
    const id = () => `n${n++}`;
    expect(synthesizeSplatFacts([mk('confirmed')], [`assets/splats/${ID}`], 's', id)).toEqual([]);
    expect(synthesizeSplatFacts([mk('pending')], [`assets/splats/${ID}`], 's', id)).toEqual([]);
    expect(synthesizeSplatFacts([mk('rejected')], [`assets/splats/${ID}`], 's', id).length).toBeGreaterThan(0);
  });
});

describe('backfill: a fact whose bytes are missing gets them from the folder', () => {
  const fact = (status: Statement['status'], url = URL): Statement => ({
    id: 'f' + status, s: { kind: 'iri', value: 'urn:kbase:concept/scan-x' }, p: { kind: 'iri', value: SPLAT_P }, o: { kind: 'literal', value: url },
    g: { kind: 'iri', value: 'urn:kbase:source/s' }, sourceId: 's', confidence: 1, status, createdAt: 1, updatedAt: 1,
  });

  it('missing bytes and file present: stored once, read once, across repeated polls', async () => {
    const { backfillSplatFiles } = await import('../../storage/splat-folder');
    const database = new FakeDB();
    const read = vi.fn(async () => new Uint8Array([1, 2, 3]));
    expect(await backfillSplatFiles([fact('pending'), fact('confirmed')], ['demo-folder'], read, database as any)).toEqual([ID]);
    expect(await backfillSplatFiles([fact('pending')], ['demo-folder'], read, database as any)).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(database.splatFiles.rows.get(ID).size).toBe(3);
  });

  it('bytes present: no read, and the stored bytes are not overwritten', async () => {
    const { backfillSplatFiles } = await import('../../storage/splat-folder');
    const database = new FakeDB();
    await database.splatFiles.put({ id: ID, blob: new Blob([new Uint8Array([9])]), filename: ID, size: 1, importedAt: 1 });
    const read = vi.fn(async () => new Uint8Array([1, 2, 3]));
    expect(await backfillSplatFiles([fact('confirmed')], ['demo-folder'], read, database as any)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(database.splatFiles.rows.get(ID).size).toBe(1);
  });

  it('file absent: nothing stored and no error; the next folder candidate is tried', async () => {
    const { backfillSplatFiles } = await import('../../storage/splat-folder');
    const database = new FakeDB();
    expect(await backfillSplatFiles([fact('pending')], ['a'], async () => null, database as any)).toEqual([]);
    expect(await backfillSplatFiles([fact('pending')], ['a'], async () => { throw new Error('boom'); }, database as any)).toEqual([]);
    expect(database.splatFiles.rows.size).toBe(0);
    const read = vi.fn(async (kb: string) => (kb === 'b' ? new Uint8Array([4]) : null));
    expect(await backfillSplatFiles([fact('pending')], ['a', 'b'], read, database as any)).toEqual([ID]);
  });

  it('a rejected fact is ignored, and so is a non-local url', async () => {
    const { backfillSplatFiles } = await import('../../storage/splat-folder');
    const database = new FakeDB();
    const read = vi.fn(async () => new Uint8Array([1]));
    expect(await backfillSplatFiles([fact('rejected'), fact('superseded'), fact('pending', '/generated/x/splat.spz')], ['f'], read, database as any)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
