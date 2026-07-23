/**
 * Archive store adapter (F97.1).
 *
 * The property worth testing here is not "does it move statements" — the pure core already proves
 * that. It is the ORDERING: the archive must be written BEFORE the working graph is cleared. There
 * is no transaction spanning two Dexie databases, so a crash between the halves is possible, and
 * the order decides whether that crash duplicates facts (recoverable) or destroys them (not).
 * These tests pin the safe order so a future refactor cannot quietly invert it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Dexie mock ───────────────────────────────────────────────────────────────
// Records every write in call order across BOTH database instances, so the test can assert the
// archive was written before the working graph was cleared.
const calls: Array<{ db: string; op: string; n: number }> = [];
let stored: Record<string, unknown[]> = {};

vi.mock('../db', () => ({
  KBaseDB: class {
    name: string;
    statements: {
      bulkPut: (rows: unknown[]) => Promise<void>;
      bulkDelete: (ids: string[]) => Promise<void>;
      toArray: () => Promise<unknown[]>;
    };
    constructor(name?: string) {
      this.name = name ?? '__working__';
      this.statements = {
        bulkPut: async (rows: unknown[]) => {
          calls.push({ db: this.name, op: 'bulkPut', n: rows.length });
          stored[this.name] = [...(stored[this.name] ?? []), ...rows];
        },
        bulkDelete: async (ids: string[]) => {
          calls.push({ db: this.name, op: 'bulkDelete', n: ids.length });
        },
        toArray: async () => stored[this.name] ?? [],
      };
    }
    close() { /* no-op */ }
  },
}));

const { runArchive, ensureArchiveKb, findArchiveKbId } = await import('../archive-store');
import type { Statement, NamedNode, Term } from '$lib/rdf/types';

const iri = (value: string): NamedNode => ({ kind: 'iri', value });
const lit = (value: string): Term => ({ kind: 'literal', value });
const st = (s: string, p: string, o: Term, id = `${s}|${p}`): Statement => ({
  id, s: iri(s), p: iri(p), o, g: iri('urn:g'),
  sourceId: 'x', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0,
});

const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const graph = [
  st('urn:keep', LABEL, lit('Keeper')),
  st('urn:gone', LABEL, lit('Goner')),
  st('urn:gone', 'urn:p/rel', iri('urn:keep')),
];

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  stored = {};
});

describe('archive graph lifecycle', () => {
  it('reports no archive graph before one exists', () => {
    expect(findArchiveKbId('Research')).toBeNull();
  });

  it('creates the archive graph on first use, named after its parent', () => {
    const id = ensureArchiveKb('Research', 'stable-1');
    expect(id).toBeTruthy();
    expect(findArchiveKbId('Research')).toBe(id);
  });

  it('is idempotent — a second call reuses the same graph', () => {
    const first = ensureArchiveKb('Research');
    const second = ensureArchiveKb('Research');
    expect(second).toBe(first);
  });

  it('links the archive back to its parent via archiveOf', async () => {
    ensureArchiveKb('Research', 'stable-99');
    const { getRegistry } = await import('../kb-registry');
    const entry = getRegistry().find((k) => k.name === 'Research (archives)')!;
    expect(entry.archiveOf).toBe('stable-99');
  });

  it('keeps separate archives for separate parents', () => {
    const a = ensureArchiveKb('Alpha');
    const b = ensureArchiveKb('Beta');
    expect(a).not.toBe(b);
  });
});

describe('runArchive — the ordering guarantee', () => {
  const run = () => runArchive({
    statements: graph,
    entities: ['urn:gone'],
    type: 'delete',
    actor: 'human',
    parentName: 'Research',
    parentStableId: 'stable-1',
    now: () => 1_700_000_000_000,
    newId: () => 'evt-1',
  });

  it('writes the ARCHIVE before deleting from the working graph', async () => {
    await run();
    const putIdx = calls.findIndex((c) => c.op === 'bulkPut');
    const delIdx = calls.findIndex((c) => c.op === 'bulkDelete');
    expect(putIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThanOrEqual(0);
    // The whole safety argument: archive first, THEN clear.
    expect(putIdx).toBeLessThan(delIdx);
  });

  it('deletes exactly what it archived — never more', async () => {
    const result = await run();
    const del = calls.find((c) => c.op === 'bulkDelete')!;
    expect(del.n).toBe(result.archivedCount);
    expect(result.archivedCount).toBe(2); // urn:gone's label + its edge
  });

  it('returns the surviving statements for the caller to adopt', async () => {
    const { kept } = await run();
    expect(kept.map((s) => s.id)).toEqual(['urn:keep|' + LABEL]);
  });

  it('writes the journal event alongside the archived statements', async () => {
    const { archiveKbId, event } = await run();
    expect(event.id).toBe('evt-1');
    expect(event.type).toBe('delete');
    // Archived statements AND the event's journal triples land in the archive graph.
    const put = calls.find((c) => c.op === 'bulkPut' && c.db === archiveKbId)!;
    expect(put.n).toBeGreaterThan(event.statementCount);
  });

  it('uses bulkPut so a retried partial archive converges instead of throwing', async () => {
    await run();
    await run(); // same event id, same statements — must not blow up
    const puts = calls.filter((c) => c.op === 'bulkPut');
    expect(puts).toHaveLength(2);
  });

  it('archiving nothing still journals, and deletes nothing', async () => {
    const result = await runArchive({
      statements: graph, entities: [], type: 'prune', actor: 'agent',
      parentName: 'Research', now: () => 1, newId: () => 'evt-empty',
    });
    expect(result.archivedCount).toBe(0);
    const del = calls.find((c) => c.op === 'bulkDelete')!;
    expect(del.n).toBe(0);
  });
});
