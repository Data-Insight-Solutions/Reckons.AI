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
const opened: string[] = [];
const closed: string[] = [];
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
      opened.push(this.name);
      this.statements = {
        bulkPut: async (rows: unknown[]) => {
          calls.push({ db: this.name, op: 'bulkPut', n: rows.length });
          const byId = new Map(
            (stored[this.name] ?? []).map((row) => [
              (row as { id?: string }).id ?? crypto.randomUUID(),
              row,
            ]),
          );
          for (const row of rows) {
            byId.set((row as { id?: string }).id ?? crypto.randomUUID(), row);
          }
          stored[this.name] = [...byId.values()];
        },
        bulkDelete: async (ids: string[]) => {
          calls.push({ db: this.name, op: 'bulkDelete', n: ids.length });
          const doomed = new Set(ids);
          stored[this.name] = (stored[this.name] ?? [])
            .filter((row) => !doomed.has((row as { id?: string }).id ?? ''));
        },
        toArray: async () => stored[this.name] ?? [],
      };
    }
    close() { closed.push(this.name); }
  },
}));

const {
  runArchive, ensureArchiveKb, findArchiveKbId, loadArchiveSnapshot,
  loadArchivedFacts, findArchivedReferencesForParent,
} = await import('../archive-store');
const {
  createKb, getRegistry, registerStableId, updateKbEntry,
} = await import('../kb-registry');
const {
  ARCHIVE_EVENT_PREFIX, ARC_SNAPSHOT_ITEM, ARC_TYPE, SnapshotUnavailableError,
  eventToStatements,
} = await import('$lib/rdf/archive');
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

let workingKbId = '';
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  calls.length = 0;
  opened.length = 0;
  closed.length = 0;
  stored = {};
  workingKbId = createKb('Research').id;
  registerStableId(workingKbId, 'stable-1');
});

describe('archive graph lifecycle', () => {
  it('reports no archive graph before one exists', () => {
    expect(findArchiveKbId('stable-1')).toBeNull();
  });

  it('creates the archive graph on first use, named after its parent', () => {
    const id = ensureArchiveKb('Research', 'stable-1');
    expect(id).toBeTruthy();
    expect(findArchiveKbId('stable-1')).toBe(id);
  });

  it('is idempotent — a second call reuses the same graph', () => {
    const first = ensureArchiveKb('Research', 'stable-1');
    const second = ensureArchiveKb('Research', 'stable-1');
    expect(second).toBe(first);
  });

  it('links the archive back to its parent via archiveOf', async () => {
    ensureArchiveKb('Research', 'stable-99');
    const entry = getRegistry().find((k) => k.name === 'Research (archives)')!;
    expect(entry.archiveOf).toBe('stable-99');
  });

  it('keeps separate archives for separate parents', () => {
    const a = ensureArchiveKb('Alpha', 'stable-a');
    const b = ensureArchiveKb('Beta', 'stable-b');
    expect(a).not.toBe(b);
  });

  it('follows stable identity across a parent rename and updates the archive display name', async () => {
    const first = ensureArchiveKb('Research', 'stable-1');
    const second = ensureArchiveKb('Renamed Research', 'stable-1');

    expect(second).toBe(first);
    expect(getRegistry().find((k) => k.id === first)?.name).toBe('Renamed Research (archives)');
    expect(getRegistry().filter((k) => k.archiveOf === 'stable-1')).toHaveLength(1);
  });

  it('does not conflate same-named parents with different stable identities', async () => {
    const a = ensureArchiveKb('Research', 'stable-a');
    const b = ensureArchiveKb('Research', 'stable-b');

    expect(b).not.toBe(a);
    expect(getRegistry().find((k) => k.id === a)?.archiveOf).toBe('stable-a');
    expect(getRegistry().find((k) => k.id === b)?.archiveOf).toBe('stable-b');
  });

  it('upgrades a legacy name-linked archive to stable identity', async () => {
    const legacy = createKb('Research (archives)');
    updateKbEntry(legacy.id, { archiveOf: 'Research' });

    expect(ensureArchiveKb('Research', 'stable-1')).toBe(legacy.id);
    expect(getRegistry().find((k) => k.id === legacy.id)?.archiveOf).toBe('stable-1');
  });

  it('refuses an empty parent stable ID', () => {
    expect(() => ensureArchiveKb('Research', '  ')).toThrow('stable ID is required');
  });
});

describe('archived fact reads (F97.3)', () => {
  it('returns an empty set without opening a database when the parent has no archive', async () => {
    await expect(loadArchivedFacts('stable-1')).resolves.toEqual([]);
    expect(opened).toEqual([]);
  });

  it('rejects a blank stable ID before opening a database', async () => {
    await expect(loadArchivedFacts('  ')).rejects.toThrow('stable ID is required');
    expect(opened).toEqual([]);
  });

  it('returns original facts while excluding both journal and snapshot wrapper rows', async () => {
    const archiveKbId = ensureArchiveKb('Research', 'stable-1');
    const fact = st('urn:gone', LABEL, lit('Goner'), 'fact');
    const journal = eventToStatements({
      id: 'evt-1',
      type: 'prune',
      at: 1,
      actor: 'human',
      entities: ['urn:gone'],
      statementCount: 1,
    });
    const snapshot = st(
      `${ARCHIVE_EVENT_PREFIX}evt-1`,
      ARC_SNAPSHOT_ITEM,
      lit(JSON.stringify(fact)),
      'snapshot',
    );
    stored[archiveKbId] = [fact, ...journal, snapshot];

    await expect(loadArchivedFacts('stable-1')).resolves.toEqual([fact]);
    expect(opened).toEqual([archiveKbId]);
    expect(closed).toEqual([archiveKbId]);
  });

  it('composes the stable-ID storage read with conservative reference matching', async () => {
    const archiveKbId = ensureArchiveKb('Research', 'stable-1');
    const event = eventToStatements({
      id: 'evt-1',
      type: 'prune',
      at: 1,
      actor: 'human',
      entities: ['urn:gone'],
      statementCount: 2,
    });
    stored[archiveKbId] = [
      st('urn:gone', LABEL, lit('Goner'), 'archived-label'),
      st('urn:active-neighbour', 'urn:p/relates-to', iri('urn:gone'), 'inbound-edge'),
      ...event,
    ];
    const incoming = [
      st('urn:new-gone', LABEL, lit('  goner '), 'incoming'),
      st('urn:active-neighbour', 'urn:p/new', lit('still active'), 'active-neighbour'),
    ];

    await expect(findArchivedReferencesForParent('stable-1', incoming)).resolves.toMatchObject([
      { entity: 'urn:gone', label: 'Goner', incoming: [incoming[0]] },
    ]);
  });
});

describe('runArchive — the ordering guarantee', () => {
  const run = () => runArchive({
    statements: graph,
    entities: ['urn:gone'],
    type: 'delete',
    actor: 'human',
    workingKbId,
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

  it('deletes from the explicit working database rather than ambient tab state', async () => {
    sessionStorage.setItem('sessionKbId', 'kbase_wrong_tab');
    await run();
    const del = calls.find((c) => c.op === 'bulkDelete')!;
    expect(del.db).toBe(workingKbId);
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

  it('persists and reloads the full pre-operation snapshot exactly', async () => {
    const { archiveKbId, event } = await run();
    await expect(loadArchiveSnapshot(archiveKbId, event.id)).resolves.toEqual(graph);
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
      workingKbId, parentName: 'Research', parentStableId: 'stable-1',
      now: () => 1, newId: () => 'evt-empty',
    });
    expect(result.archivedCount).toBe(0);
    const del = calls.find((c) => c.op === 'bulkDelete')!;
    expect(del.n).toBe(0);
  });

  it('refuses to use the archive itself as the working database', async () => {
    const archiveKbId = ensureArchiveKb('Research', 'stable-1');
    await expect(runArchive({
      statements: graph,
      entities: ['urn:gone'],
      type: 'delete',
      actor: 'human',
      workingKbId: archiveKbId,
      parentName: 'Research',
      parentStableId: 'stable-1',
    })).rejects.toThrow('must be different');
    expect(calls).toHaveLength(0);
  });

  it('refuses an unregistered working database before creating an archive', async () => {
    await expect(runArchive({
      statements: graph,
      entities: ['urn:gone'],
      type: 'delete',
      actor: 'human',
      workingKbId: 'kbase_missing',
      parentName: 'Missing',
      parentStableId: 'stable-missing',
    })).rejects.toThrow('Working KB is not registered');
    expect(findArchiveKbId('stable-missing')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('refuses a working database whose registry stable ID belongs to another parent', async () => {
    await expect(runArchive({
      statements: graph,
      entities: ['urn:gone'],
      type: 'delete',
      actor: 'human',
      workingKbId,
      parentName: 'Research',
      parentStableId: 'stable-other',
    })).rejects.toThrow('does not match the parent stable ID');
    expect(findArchiveKbId('stable-other')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('refuses an empty working database ID before creating an archive', async () => {
    await expect(runArchive({
      statements: graph,
      entities: ['urn:gone'],
      type: 'delete',
      actor: 'human',
      workingKbId: ' ',
      parentName: 'Research',
      parentStableId: 'stable-1',
    })).rejects.toThrow('Working KB ID is required');
    expect(findArchiveKbId('stable-1')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('runArchive — retention is part of the writer', () => {
  const runNumbered = (i: number, milestone = false) => runArchive({
    statements: graph,
    entities: ['urn:gone'],
    type: 'age-drop',
    actor: 'schedule',
    workingKbId,
    parentName: 'Research',
    parentStableId: 'stable-1',
    milestone,
    now: () => 1_700_000_000_000 + i,
    newId: () => `evt-${i}`,
  });

  it('keeps only the latest 10 snapshot payloads by default while preserving every event', async () => {
    let archiveKbId = '';
    for (let i = 0; i < 12; i++) ({ archiveKbId } = await runNumbered(i));

    const rows = stored[archiveKbId] as Statement[];
    const payloads = rows.filter((row) => row.p.value === ARC_SNAPSHOT_ITEM);
    const eventTypes = rows.filter((row) => row.p.value === ARC_TYPE);
    expect(payloads).toHaveLength(10 * graph.length);
    expect(eventTypes).toHaveLength(12);
    await expect(loadArchiveSnapshot(archiveKbId, 'evt-11')).resolves.toEqual(graph);
    await expect(loadArchiveSnapshot(archiveKbId, 'evt-0'))
      .rejects.toBeInstanceOf(SnapshotUnavailableError);
  });

  it('keeps a milestone snapshot outside the latest-10 window', async () => {
    let archiveKbId = '';
    for (let i = 0; i < 12; i++) ({ archiveKbId } = await runNumbered(i, i === 0));

    const payloads = (stored[archiveKbId] as Statement[])
      .filter((row) => row.p.value === ARC_SNAPSHOT_ITEM);
    expect(payloads).toHaveLength(11 * graph.length);
    await expect(loadArchiveSnapshot(archiveKbId, 'evt-0')).resolves.toEqual(graph);
    await expect(loadArchiveSnapshot(archiveKbId, 'evt-1'))
      .rejects.toBeInstanceOf(SnapshotUnavailableError);
  });

  it('finishes retention before touching the working graph', async () => {
    for (let i = 0; i < 10; i++) await runNumbered(i);
    calls.length = 0;

    const { archiveKbId } = await runNumbered(10);
    expect(calls.map(({ db, op }) => ({ db, op }))).toEqual([
      { db: archiveKbId, op: 'bulkPut' },
      { db: archiveKbId, op: 'bulkDelete' },
      { db: workingKbId, op: 'bulkDelete' },
    ]);
  });
});
