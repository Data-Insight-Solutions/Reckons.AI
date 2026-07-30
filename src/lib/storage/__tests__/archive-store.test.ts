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
let storedSources: Record<string, Array<{ id: string }>> = {};
let bulkPutCall = 0;
let failBulkPutCall: number | null = null;

vi.mock('../db', () => ({
  KBaseDB: class {
    name: string;
    statements: {
      bulkPut: (rows: unknown[]) => Promise<void>;
      bulkDelete: (ids: string[]) => Promise<void>;
      toArray: () => Promise<unknown[]>;
    };
    sources: {
      toArray: () => Promise<Array<{ id: string }>>;
    };
    constructor(name?: string) {
      this.name = name ?? '__working__';
      opened.push(this.name);
      this.statements = {
        bulkPut: async (rows: unknown[]) => {
          bulkPutCall++;
          calls.push({ db: this.name, op: 'bulkPut', n: rows.length });
          if (failBulkPutCall === bulkPutCall) throw new Error('injected bulkPut failure');
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
      this.sources = {
        toArray: async () => storedSources[this.name] ?? [],
      };
    }
    async transaction(_mode: string, ...args: unknown[]) {
      const callback = args.at(-1) as () => Promise<unknown>;
      const before = structuredClone(stored[this.name] ?? []);
      try {
        return await callback();
      } catch (error) {
        stored[this.name] = before;
        throw error;
      }
    }
    close() { closed.push(this.name); }
  },
}));

const {
  runArchive, ensureArchiveKb, findArchiveKbId, loadArchiveSnapshot,
  loadArchivedFacts, findArchivedReferencesForParent, restoreArchivedEntityForParent,
  sweepArchiveByAge,
  ArchivedEntityRestoreError, ArchivedStatementCollisionError,
} = await import('../archive-store');
const {
  createKb, getRegistry, registerStableId, updateKbEntry,
} = await import('../kb-registry');
const {
  ARCHIVE_EVENT_PREFIX, ARC_COMMITTED, ARC_SNAPSHOT_ITEM, ARC_TYPE,
  SnapshotUnavailableError, eventToStatements, statementsToEvents,
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
  storedSources = {};
  bulkPutCall = 0;
  failBulkPutCall = null;
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

describe('restoreArchivedEntityForParent — reversible storage primitive (F97.2/F97.3)', () => {
  const seedArchive = () => {
    const archiveKbId = ensureArchiveKb('Research', 'stable-1');
    const archivedLabel = {
      ...st('urn:gone', LABEL, lit('Goner'), 'archived-label'),
      sourceId: 'original-source',
      confidence: 0.73,
      excerpt: 'verbatim evidence',
      grounded: true,
      createdAt: 123,
      updatedAt: 456,
    };
    const inbound = st(
      'urn:active-neighbour',
      'urn:p/relates-to',
      iri('urn:gone'),
      'archived-inbound',
    );
    const rejected = {
      ...st('urn:gone', 'urn:p/rejected', lit('no'), 'archived-rejected'),
      status: 'rejected' as const,
    };
    const archivedPeerEdge = st(
      'urn:gone',
      'urn:p/related-archived',
      iri('urn:peer'),
      'archived-peer-edge',
    );
    const archivedPeerLabel = st('urn:peer', LABEL, lit('Peer'), 'archived-peer-label');
    const unrelated = st('urn:other', LABEL, lit('Other'), 'archived-unrelated');
    const event = eventToStatements({
      id: 'archive-1',
      type: 'delete',
      at: 1,
      actor: 'human',
      entities: ['urn:gone'],
      statementCount: 3,
      parentStableId: 'stable-1',
    });
    const peerEvent = eventToStatements({
      id: 'archive-peer',
      type: 'delete',
      at: 1,
      actor: 'human',
      entities: ['urn:peer'],
      statementCount: 2,
      parentStableId: 'stable-1',
    });
    stored[archiveKbId] = [
      archivedLabel,
      inbound,
      rejected,
      archivedPeerEdge,
      archivedPeerLabel,
      unrelated,
      ...event,
      ...peerEvent,
    ];
    stored[workingKbId] = [graph[0]];
    storedSources[workingKbId] = [{ id: 'x' }, { id: 'original-source' }];
    return {
      archiveKbId,
      archivedLabel,
      inbound,
      rejected,
      archivedPeerEdge,
      archivedPeerLabel,
      unrelated,
    };
  };

  const restore = () => restoreArchivedEntityForParent({
    workingKbId,
    parentStableId: 'stable-1',
    entity: 'urn:gone',
    actor: 'human',
    now: () => 2,
    newId: () => 'restore-1',
  });

  it('prepares recovery, copies exact active facts, then commits the journal', async () => {
    const {
      archiveKbId,
      archivedLabel,
      inbound,
      rejected,
      archivedPeerEdge,
      archivedPeerLabel,
      unrelated,
    } = seedArchive();
    const incoming = [st('urn:new-gone', LABEL, lit('goner'), 'incoming')];
    await expect(findArchivedReferencesForParent('stable-1', incoming)).resolves.toHaveLength(1);

    const result = await restore();

    expect(result.alreadyRestored).toBe(false);
    expect(result.restored).toEqual([archivedLabel, inbound]);
    expect(result.event).toMatchObject({
      id: 'restore-1',
      type: 'revert',
      entities: ['urn:gone'],
      statementCount: 2,
      committed: true,
    });

    // Prepare is durable first, the working copy lands second, and only then can the event say
    // committed=true. The false marker is deleted inside the final archive transaction.
    expect(calls.map(({ db, op }) => ({ db, op }))).toEqual([
      { db: archiveKbId, op: 'bulkPut' },
      { db: workingKbId, op: 'bulkPut' },
      { db: archiveKbId, op: 'bulkDelete' },
      { db: archiveKbId, op: 'bulkPut' },
    ]);

    const workingRows = stored[workingKbId] as Statement[];
    expect(workingRows).toEqual([graph[0], archivedLabel, inbound]);
    expect(workingRows).not.toContainEqual(rejected);
    expect(workingRows).not.toContainEqual(archivedPeerEdge);
    expect(workingRows).not.toContainEqual(archivedPeerLabel);
    expect(workingRows).not.toContainEqual(unrelated);

    // Historical archive facts stay put; the newest completed event changes their membership.
    expect(stored[archiveKbId]).toContainEqual(archivedLabel);
    expect(stored[archiveKbId]).toContainEqual(inbound);
    expect(statementsToEvents(stored[archiveKbId] as Statement[])[0]).toMatchObject({
      id: 'restore-1',
      committed: true,
    });
    await expect(findArchivedReferencesForParent('stable-1', incoming)).resolves.toEqual([]);

    // Undoing this restore can recover the exact graph from immediately before it.
    await expect(loadArchiveSnapshot(archiveKbId, 'restore-1')).resolves.toEqual([graph[0]]);
  });

  it('keeps a recoverable prepared event when the working write fails', async () => {
    const { archiveKbId } = seedArchive();
    failBulkPutCall = 2; // prepare succeeds; working transaction fails before writing

    await expect(restore()).rejects.toThrow('injected bulkPut failure');
    expect(stored[workingKbId]).toEqual([graph[0]]);
    expect(statementsToEvents(stored[archiveKbId] as Statement[])[0]).toMatchObject({
      id: 'restore-1',
      committed: false,
    });
    expect((stored[archiveKbId] as Statement[]).some(
      (row) => row.p.value === ARC_COMMITTED && row.o.value === 'false',
    )).toBe(true);

    failBulkPutCall = null;
    const retried = await restore();
    expect(retried.event.committed).toBe(true);
    expect(stored[workingKbId]).toHaveLength(3);
  });

  it('keeps the new undo snapshot even when a caller requests keepLast zero', async () => {
    const { archiveKbId } = seedArchive();
    await restoreArchivedEntityForParent({
      workingKbId,
      parentStableId: 'stable-1',
      entity: 'urn:gone',
      actor: 'human',
      retentionPolicy: { keepLast: 0 },
      now: () => 2,
      newId: () => 'restore-1',
    });

    await expect(loadArchiveSnapshot(archiveKbId, 'restore-1')).resolves.toEqual([graph[0]]);
  });

  it('recovers a crash after the working copy without losing the pre-restore snapshot', async () => {
    const { archiveKbId } = seedArchive();
    failBulkPutCall = 3; // final committed-event write fails and its transaction rolls back

    await expect(restore()).rejects.toThrow('injected bulkPut failure');
    expect(stored[workingKbId]).toHaveLength(3);
    expect(statementsToEvents(stored[archiveKbId] as Statement[])[0]).toMatchObject({
      id: 'restore-1',
      committed: false,
    });
    await expect(loadArchiveSnapshot(archiveKbId, 'restore-1')).resolves.toEqual([graph[0]]);

    failBulkPutCall = null;
    const recovered = await restore();
    expect(recovered.alreadyRestored).toBe(false);
    expect(recovered.event.committed).toBe(true);
    expect(stored[workingKbId]).toHaveLength(3);
    await expect(loadArchiveSnapshot(archiveKbId, 'restore-1')).resolves.toEqual([graph[0]]);

    const completedRetry = await restore();
    expect(completedRetry.alreadyRestored).toBe(true);
    expect(statementsToEvents(stored[archiveKbId] as Statement[])
      .filter((event) => event.type === 'revert')).toHaveLength(1);
  });

  it('refuses to resume a prepared restore across unrelated working-graph changes', async () => {
    const { archiveKbId } = seedArchive();
    failBulkPutCall = 2; // leave a durable prepared event before the working write
    await expect(restore()).rejects.toThrow('injected bulkPut failure');

    stored[workingKbId] = [
      ...(stored[workingKbId] as Statement[]),
      st('urn:concurrent', LABEL, lit('Added elsewhere'), 'concurrent-change'),
    ];
    failBulkPutCall = null;

    await expect(restore()).rejects.toThrow('Working graph changed after the restore was prepared');
    expect((stored[workingKbId] as Statement[]).map((row) => row.id)).toEqual([
      graph[0].id,
      'concurrent-change',
    ]);
    expect(statementsToEvents(stored[archiveKbId] as Statement[])[0]).toMatchObject({
      id: 'restore-1',
      committed: false,
      restoreScope: 'entity',
    });
  });

  it('refuses a same-ID content collision before preparing any mutation', async () => {
    const { archiveKbId, archivedLabel } = seedArchive();
    stored[workingKbId] = [
      graph[0],
      { ...archivedLabel, o: lit('Different content') },
    ];

    await expect(restore()).rejects.toBeInstanceOf(ArchivedStatementCollisionError);
    expect(calls).toEqual([]);
    expect(statementsToEvents(stored[archiveKbId] as Statement[])).toHaveLength(2);
  });

  it('refuses to restore facts whose source provenance is no longer available', async () => {
    const { archiveKbId } = seedArchive();
    storedSources[workingKbId] = [{ id: 'x' }];

    await expect(restore()).rejects.toThrow('missing source record(s) original-source');
    expect(calls).toEqual([]);
    expect(statementsToEvents(stored[archiveKbId] as Statement[])).toHaveLength(2);
  });

  it('fails loudly when identity or archive evidence is unavailable', async () => {
    await expect(restore()).rejects.toBeInstanceOf(ArchivedEntityRestoreError);

    seedArchive();
    await expect(restoreArchivedEntityForParent({
      workingKbId,
      parentStableId: 'stable-other',
      entity: 'urn:gone',
      actor: 'human',
    })).rejects.toThrow('does not match the parent stable ID');
    await expect(restoreArchivedEntityForParent({
      workingKbId,
      parentStableId: 'stable-1',
      entity: 'urn:not-archived',
      actor: 'human',
    })).rejects.toThrow('has no journal event');
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

// ── F97 age sweep: the entry point ───────────────────────────────────────────
describe('age sweep', () => {
  const SCHEDULED = 'urn:kbase:predicate/scheduled-at';
  const NOW = Date.parse('2026-07-30T12:00:00Z');
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

  const dated = [
    st('urn:old', SCHEDULED, lit(daysAgo(400)), 'old|when'),
    st('urn:old', LABEL, lit('Last year'), 'old|label'),
    st('urn:new', SCHEDULED, lit(daysAgo(2)), 'new|when'),
    st('urn:new', LABEL, lit('This week'), 'new|label'),
  ];

  const sweep = (statements: Statement[], olderThanDays = 90) =>
    sweepArchiveByAge({
      statements,
      olderThanDays,
      workingKbId,
      parentName: 'Research',
      parentStableId: 'stable-1',
      actor: 'human',
      now: () => NOW,
      newId: () => 'evt-sweep',
    });

  it('moves only the aged entity and keeps the current one', async () => {
    // Seed the working store so the DELETE half is observable, not just the returned `kept`.
    stored[workingKbId] = [...dated];
    const { plan, run } = await sweep(dated);

    expect(plan.entities).toEqual(['urn:old']);
    expect(run).not.toBeNull();
    expect(run!.archivedCount).toBe(2);
    expect(run!.kept.map((s) => s.id).sort()).toEqual(['new|label', 'new|when']);
    expect((stored[workingKbId] ?? []).map((r) => (r as Statement).id).sort())
      .toEqual(['new|label', 'new|when']);
  });

  it('journals the move as an age-drop', async () => {
    const { run } = await sweep(dated);
    const [event] = statementsToEvents(stored[run!.archiveKbId] as Statement[]);
    expect(event.type).toBe('age-drop');
    expect(event.entities).toEqual(['urn:old']);
    expect(event.note).toContain('older than 90 days');
  });

  it('creates NO archive graph when the sweep would move nothing', async () => {
    const recentOnly = dated.filter((s) => s.id.startsWith('new'));
    const { plan, run } = await sweep(recentOnly);

    expect(run).toBeNull();
    expect(plan.entities).toEqual([]);
    // The empty-sweep failure mode: a permanent archive row appearing as the only visible result.
    expect(findArchiveKbId('stable-1')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('still returns the plan when nothing moved, so the user learns why', async () => {
    const { plan } = await sweep([
      st('urn:undated', LABEL, lit('No date'), 'u|label'),
      st('urn:held', SCHEDULED, lit(daysAgo(400)), 'h|when'),
      { ...st('urn:held', LABEL, lit('?'), 'h|label'), status: 'pending' as const },
    ]);

    expect(plan.entities).toEqual([]);
    expect(plan.undatedCount).toBe(1);
    expect(plan.heldForReview).toEqual(['urn:held']);
  });

  it('leaves a held-for-review entity in the working graph', async () => {
    const graphWithPending = [
      ...dated,
      { ...st('urn:old', 'urn:p/note', lit('unsettled'), 'old|pending'), status: 'pending' as const },
    ];
    const { plan, run } = await sweep(graphWithPending);

    expect(plan.heldForReview).toEqual(['urn:old']);
    expect(run).toBeNull();
    expect(findArchiveKbId('stable-1')).toBeNull();
  });

  it('refuses a threshold that would sweep the whole graph', async () => {
    await expect(sweep(dated, 0)).rejects.toThrow(/positive number of days/);
    expect(calls).toEqual([]);
  });
});

describe('reactive state never reaches IndexedDB', () => {
  // Regression, 2026-07-30. Dexie stores STRUCTURED CLONES and a Svelte 5 `$state` array hands
  // out Proxies that structuredClone refuses. Every unit suite was green while the real browser
  // threw DataCloneError mid-move, because a mocked Dexie clones nothing — so this test asserts
  // the property directly rather than trusting the mock to reproduce it.
  it('writes structured-cloneable rows even when handed proxied statements', async () => {
    const proxied = graph.map((s) => new Proxy(s, {
      get: (target, key) => Reflect.get(target, key),
    }));

    const { archiveKbId } = await runArchive({
      statements: proxied,
      entities: ['urn:gone'],
      type: 'delete',
      actor: 'human',
      workingKbId,
      parentName: 'Research',
      parentStableId: 'stable-1',
      now: () => 1,
      newId: () => 'evt-proxy',
    });

    // structuredClone is what Dexie actually performs. If any proxy survived, this throws.
    expect(() => structuredClone(stored[archiveKbId])).not.toThrow();
    expect(() => structuredClone(stored[workingKbId] ?? [])).not.toThrow();
  });
});
