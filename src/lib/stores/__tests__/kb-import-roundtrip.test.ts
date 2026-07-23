/**
 * F107.4 data-safety core: the sync reconcile path (`populateKbFromTtl`) must round-trip a
 * lossless `toTurtleFull` export with EVERY status and its provenance intact, must keep treating
 * a plain external TTL as confirmed knowledge, and must snapshot a KB before replacing it.
 *
 * Uses REAL serialize + import-ttl against an in-memory fake DB target (jsdom has no IndexedDB),
 * so the fidelity being asserted is the actual serialization round-trip, not a mock's.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Statement, Source } from '../../rdf/types';

// kb-import imports these at module load but the reconcile path uses the passed `target`, not
// the module-level db. Stub them so importing the module never touches a real Dexie/IndexedDB.
vi.mock('../../storage/db', () => ({ db: {}, KBaseDB: class {}, DEFAULT_SETTINGS: {} }));

class FakeTable {
  rows = new Map<string, any>();
  async toArray() { return [...this.rows.values()]; }
  async put(r: any) { this.rows.set(r.id, r); }
  async bulkPut(rs: any[]) { for (const r of rs) this.rows.set(r.id, r); }
  async bulkDelete(ks: string[]) { for (const k of ks) this.rows.delete(k); }
  async clear() { this.rows.clear(); }
  async get(k: string) { return this.rows.get(k); }
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
  kbSnapshots = new FakeTable();
  constructor(name = 'kbase') { this.name = name; }
  async transaction(_mode: string, _tables: unknown, cb: () => Promise<unknown>) { return cb(); }
}

const iri = (value: string) => ({ kind: 'iri' as const, value });
const lit = (value: string) => ({ kind: 'literal' as const, value });

function stmt(over: Partial<Statement>): Statement {
  return {
    id: crypto.randomUUID(),
    s: iri('urn:kbase:concept/trip'),
    p: iri('urn:kbase:predicate/hasDetail'),
    o: lit('detail'),
    g: iri('urn:kbase:source/src-a'),
    sourceId: 'src-a',
    confidence: 0.9,
    status: 'confirmed',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

const sources: Source[] = [
  { id: 'src-a', title: 'Trip note', uri: 'note://trip', kind: 'note', ingestedAt: 1_700_000_000_000, trustLevel: 'trusted' },
  { id: 'src-b', title: 'Web page', uri: 'https://example.com', kind: 'url', ingestedAt: 1_700_000_500_000, trustLevel: 'review' },
];

describe('populateKbFromTtl — lossless round-trip (F107.4)', () => {
  let toTurtleFull: typeof import('../../rdf/serialize').toTurtleFull;
  let populateKbFromTtl: typeof import('../kb-import').populateKbFromTtl;

  beforeEach(async () => {
    ({ toTurtleFull } = await import('../../rdf/serialize'));
    ({ populateKbFromTtl } = await import('../kb-import'));
  });

  it('preserves every status and its provenance through export → import', async () => {
    const input: Statement[] = [
      stmt({ id: 'st-confirmed', status: 'confirmed', o: lit('a') }),
      stmt({ id: 'st-refined', status: 'refined', o: lit('b') }),
      stmt({ id: 'st-pending', status: 'pending', o: lit('c'), sourceId: 'src-b', g: iri('urn:kbase:source/src-b') }),
      stmt({ id: 'st-pending-removal', status: 'pending-removal', o: lit('d') }),
      stmt({ id: 'st-rejected', status: 'rejected', o: lit('e') }),
      stmt({ id: 'st-superseded', status: 'superseded', o: lit('f'), supersedes: 'st-refined' }),
    ];

    const ttl = toTurtleFull(input, sources);
    const target = new FakeDB('kbase');
    const written = await populateKbFromTtl(target as any, 'Trip', 'workspace://trip.ttl', ttl, new Map());

    const out = await target.statements.toArray();
    expect(written).toBe(input.length);

    // THE data-loss assertion: no status was filtered out or coerced to confirmed.
    expect(new Set(out.map((s: Statement) => s.status))).toEqual(
      new Set(['confirmed', 'refined', 'pending', 'pending-removal', 'rejected', 'superseded'])
    );

    // Provenance survives: both sources are present, not collapsed into one synthetic source.
    const outSources = await target.sources.toArray();
    expect(new Set(outSources.map((s: Source) => s.id))).toEqual(new Set(['src-a', 'src-b']));

    // The pending statement kept its distinct source, and the supersedes link survived.
    const pending = out.find((s: Statement) => s.status === 'pending');
    expect(pending?.sourceId).toBe('src-b');
    const superseded = out.find((s: Statement) => s.status === 'superseded');
    expect(superseded?.supersedes).toBe('st-refined');
  });

  it('treats a plain external TTL as confirmed knowledge (legacy compatibility)', async () => {
    const plain = '<urn:kbase:concept/x> <urn:kbase:predicate/rel> <urn:kbase:concept/y> .';
    const target = new FakeDB('kbase');
    const written = await populateKbFromTtl(target as any, 'Plain', 'workspace://plain.ttl', plain, new Map());

    const out = await target.statements.toArray();
    expect(written).toBe(1);
    expect(out[0].status).toBe('confirmed');
    // One synthetic source, as before — a plain file carries no provenance to preserve.
    expect(await target.sources.toArray()).toHaveLength(1);
  });

  it('snapshots the prior state before a destructive replace, and can restore it', async () => {
    const target = new FakeDB('kbase');
    // Seed a KB with a pending statement that a naive re-import would have destroyed.
    const original = [stmt({ id: 'orig-pending', status: 'pending', o: lit('keep-me') })];
    await populateKbFromTtl(target as any, 'Trip', 'workspace://trip.ttl', toTurtleFull(original, sources), new Map());
    expect(await target.kbSnapshots.toArray()).toHaveLength(0); // first import: nothing to snapshot

    // Replace with different content.
    const replacement = [stmt({ id: 'new-confirmed', status: 'confirmed', o: lit('replaced') })];
    await populateKbFromTtl(target as any, 'Trip', 'workspace://trip.ttl', toTurtleFull(replacement, sources), new Map());

    const snaps = await target.kbSnapshots.toArray();
    expect(snaps).toHaveLength(1);
    expect(snaps[0].statementCount).toBe(1);

    // Restore recovers the original pending statement.
    const { restoreKbSnapshot } = await import('../../storage/kb-snapshots');
    await restoreKbSnapshot(target as any, snaps[0].id);
    const restored = await target.statements.toArray();
    expect(restored.some((s: Statement) => s.id === 'orig-pending' && s.status === 'pending')).toBe(true);
  });
});
