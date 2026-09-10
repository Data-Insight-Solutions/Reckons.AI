import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionRun, Source, Statement } from '../../rdf/types';

type Row = { id: string; [key: string]: unknown };
const rows = {
  sources: new Map<string, Row>(),
  statements: new Map<string, Row>(),
  extractionRuns: new Map<string, Row>(),
  changelog: new Map<string, Row>(),
  trustEvents: new Map<string, Row>(),
};
let failStatementWrite = false;
let failTrustWrite = false;
let changelogSequence = 0;

function table(name: keyof typeof rows) {
  return {
    async get(id: string) {
      const row = rows[name].get(id);
      return row ? structuredClone(row) : undefined;
    },
    async put(row: Row) {
      if (name === 'statements' && failStatementWrite) throw new Error('statement write failed');
      rows[name].set(row.id, structuredClone(row));
    },
    async bulkPut(incoming: Row[]) {
      if (name === 'statements' && failStatementWrite) throw new Error('statement write failed');
      for (const row of incoming) rows[name].set(row.id, structuredClone(row));
    },
    async bulkAdd(incoming: Row[]) {
      for (const row of incoming) {
        const id = row.id || `log-${++changelogSequence}`;
        rows[name].set(id, structuredClone({ ...row, id }));
      }
    },
    async bulkGet(ids: string[]) {
      return ids.map((id) => {
        const row = rows[name].get(id);
        return row ? structuredClone(row) : undefined;
      });
    },
    async add(row: Row) {
      if (name === 'trustEvents' && failTrustWrite) throw new Error('trust write failed');
      const id = row.id || `log-${++changelogSequence}`;
      rows[name].set(id, structuredClone({ ...row, id }));
      return id;
    },
  };
}

const db = {
  sources: table('sources'),
  statements: table('statements'),
  extractionRuns: table('extractionRuns'),
  changelog: table('changelog'),
  trustEvents: table('trustEvents'),
  async transaction(_mode: string, ...args: unknown[]) {
    const snapshots = Object.fromEntries(
      Object.entries(rows).map(([name, store]) => [name, new Map(store)]),
    ) as typeof rows;
    const callback = args.at(-1) as () => Promise<unknown>;
    try {
      return await callback();
    } catch (error) {
      for (const name of Object.keys(rows) as Array<keyof typeof rows>) {
        rows[name].clear();
        for (const [id, row] of snapshots[name]) rows[name].set(id, row);
      }
      throw error;
    }
  },
};

vi.mock('../../storage/db', () => ({ db }));
vi.mock('../workspace.svelte', () => ({ scheduleWorkspaceTtlExport: vi.fn() }));
vi.mock('../drive-sync.svelte', () => ({ scheduleDrivePush: vi.fn() }));
vi.mock('../official-kb.svelte', () => ({
  officialKbActive: () => false,
  officialKbStatements: () => [],
  officialKbSources: () => [],
  deactivateOfficialKb: vi.fn(),
}));
vi.mock('../../storage/backup', () => ({ scheduleAutoSave: vi.fn() }));

const { persistIngestBatch, persistSourceBatch, setStatuses } = await import('../kb.svelte');

const source: Source = {
  id: 'source-atomic', title: 'Atomic ingest', uri: 'note://atomic', kind: 'note', ingestedAt: 1,
};
const statement: Statement = {
  id: 'statement-atomic',
  s: { kind: 'iri', value: 'urn:subject' },
  p: { kind: 'iri', value: 'urn:predicate' },
  o: { kind: 'literal', value: 'object' },
  g: { kind: 'iri', value: 'urn:source' },
  sourceId: source.id, status: 'pending', confidence: 0.7, createdAt: 1, updatedAt: 1,
};
const terminalRun: ExtractionRun = {
  id: 'run-atomic', sourceId: source.id, sourceHash: 'hash', pipelineVersion: 'test', promptId: 'test',
  startedAt: 1, endedAt: 2, status: 'succeeded', outputStatementIds: [statement.id],
  route: {
    policyVersion: 'test', selectedBackend: 'mock', selectedModel: 'mock', locality: 'browser', reason: 'test',
    candidates: [{ backend: 'mock', model: 'mock', locality: 'browser' }], attempts: [],
  },
  stages: [],
};

beforeEach(() => {
  for (const store of Object.values(rows)) store.clear();
  failStatementWrite = false;
  failTrustWrite = false;
  changelogSequence = 0;
});

describe('atomic ingest persistence (F136.1)', () => {
  it('rolls source, statements, terminal run, and changelog back together when a statement write fails', async () => {
    failStatementWrite = true;
    await expect(persistIngestBatch(source, { statements: [statement], blocked: [] }, terminalRun))
      .rejects.toThrow('statement write failed');

    expect([...rows.sources.values()]).toEqual([]);
    expect([...rows.statements.values()]).toEqual([]);
    expect([...rows.extractionRuns.values()]).toEqual([]);
    expect([...rows.changelog.values()]).toEqual([]);
  });

  it('commits source, accepted statements, terminal run, and audit rows in one successful boundary', async () => {
    const written = await persistIngestBatch(source, { statements: [statement], blocked: [] }, terminalRun);

    expect(written).toEqual([statement]);
    expect(rows.sources.get(source.id)).toEqual(source);
    expect(rows.statements.get(statement.id)).toEqual(statement);
    expect(rows.extractionRuns.get(terminalRun.id)).toMatchObject({
      status: 'succeeded', outputStatementIds: [statement.id],
    });
    expect([...rows.changelog.values()]).toHaveLength(1);
  });

  it('retains a source and terminal run when policy intentionally holds every candidate', async () => {
    const heldRun = { ...terminalRun, id: 'run-policy-held', outputStatementIds: [] };
    const written = await persistIngestBatch(source, {
      statements: [],
      blocked: [{ statement, reasons: ['content-policy fixture'] }],
    }, heldRun);

    expect(written).toEqual([]);
    expect(rows.sources.get(source.id)).toEqual(source);
    expect([...rows.statements.values()]).toEqual([]);
    expect(rows.extractionRuns.get(heldRun.id)).toMatchObject({ outputStatementIds: [] });
    expect([...rows.changelog.values()]).toHaveLength(1);
  });
});

describe('atomic source batch persistence', () => {
  it('rolls the source and audit rows back when a queued statement cannot be written', async () => {
    failStatementWrite = true;
    await expect(persistSourceBatch(source, { statements: [statement], blocked: [] }))
      .rejects.toThrow('statement write failed');

    expect([...rows.sources.values()]).toEqual([]);
    expect([...rows.statements.values()]).toEqual([]);
    expect([...rows.changelog.values()]).toEqual([]);
  });

  it('commits a queued source, statements, and audit rows together', async () => {
    const written = await persistSourceBatch(source, { statements: [statement], blocked: [] });
    expect(written).toEqual([statement]);
    expect(rows.sources.get(source.id)).toEqual(source);
    expect(rows.statements.get(statement.id)).toEqual(statement);
    expect([...rows.changelog.values()]).toHaveLength(1);
  });

  it('treats stable source and statement ids as an idempotent delivery receipt', async () => {
    await expect(persistSourceBatch(source, { statements: [statement], blocked: [] }))
      .resolves.toEqual([statement]);
    const changelogAfterFirst = rows.changelog.size;

    await expect(persistSourceBatch(source, { statements: [statement], blocked: [] }))
      .resolves.toEqual([]);

    expect(rows.sources.size).toBe(1);
    expect(rows.statements.size).toBe(1);
    expect(rows.changelog.size).toBe(changelogAfterFirst);
  });

  it('does not duplicate a blocked-row audit when the stable source receipt is retried', async () => {
    const held = {
      statements: [],
      blocked: [{ statement, reasons: ['content-policy fixture'] }],
    };

    await expect(persistSourceBatch(source, held)).resolves.toEqual([]);
    expect(rows.sources.size).toBe(1);
    expect(rows.statements.size).toBe(0);
    expect([...rows.changelog.values()]).toHaveLength(1);
    expect([...rows.changelog.values()][0]).toMatchObject({
      action: 'reject',
      statementId: statement.id,
      note: 'content-policy: content-policy fixture',
    });

    await expect(persistSourceBatch(source, held)).resolves.toEqual([]);
    expect(rows.sources.size).toBe(1);
    expect(rows.statements.size).toBe(0);
    expect([...rows.changelog.values()]).toHaveLength(1);
  });
});

describe('atomic review settlement', () => {
  function side(id: string): Statement {
    return { ...statement, id };
  }

  it('rolls every side and audit row back if a later trust write fails', async () => {
    const sides = [side('settle-rollback-a'), side('settle-rollback-b')];
    await persistSourceBatch(source, { statements: sides, blocked: [] });
    const changelogBefore = rows.changelog.size;
    failTrustWrite = true;

    await expect(setStatuses([
      { id: sides[0].id, status: 'confirmed' },
      { id: sides[1].id, status: 'rejected' },
    ])).rejects.toThrow('trust write failed');

    expect(rows.statements.get(sides[0].id)).toMatchObject({ status: 'pending' });
    expect(rows.statements.get(sides[1].id)).toMatchObject({ status: 'pending' });
    expect(rows.changelog.size).toBe(changelogBefore);
    expect(rows.trustEvents.size).toBe(0);
  });

  it('commits every side, audit row, and trust event together', async () => {
    const sides = [side('settle-commit-a'), side('settle-commit-b')];
    await persistSourceBatch(source, { statements: sides, blocked: [] });
    const changelogBefore = rows.changelog.size;

    await setStatuses([
      { id: sides[0].id, status: 'confirmed' },
      { id: sides[1].id, status: 'rejected' },
    ]);

    expect(rows.statements.get(sides[0].id)).toMatchObject({ status: 'confirmed' });
    expect(rows.statements.get(sides[1].id)).toMatchObject({ status: 'rejected' });
    expect(rows.changelog.size).toBe(changelogBefore + 2);
    expect([...rows.trustEvents.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ statementId: sides[0].id, reason: 'confirm', delta: 0.05 }),
      expect.objectContaining({ statementId: sides[1].id, reason: 'reject', delta: -0.1 }),
    ]));
  });

  it('rejects the whole decision when any requested statement is missing', async () => {
    const existing = side('settle-existing');
    await persistSourceBatch(source, { statements: [existing], blocked: [] });
    const changelogBefore = rows.changelog.size;

    await expect(setStatuses([
      { id: existing.id, status: 'confirmed' },
      { id: 'settle-missing', status: 'rejected' },
    ])).rejects.toThrow(/missing statement/i);

    expect(rows.statements.get(existing.id)).toMatchObject({ status: 'pending' });
    expect(rows.changelog.size).toBe(changelogBefore);
    expect(rows.trustEvents.size).toBe(0);
  });

  it('preserves a concurrent durable edit instead of replacing it from stale memory', async () => {
    const existing = side('settle-fresh-read');
    await persistSourceBatch(source, { statements: [existing], blocked: [] });
    rows.statements.set(existing.id, {
      ...structuredClone(rows.statements.get(existing.id)!),
      gloss: 'edited in another tab',
    });

    await setStatuses([{ id: existing.id, status: 'confirmed' }]);

    expect(rows.statements.get(existing.id)).toMatchObject({
      status: 'confirmed',
      gloss: 'edited in another tab',
    });
  });

  it('does not rewrite, audit, or adjust trust for an idempotent status', async () => {
    const existing = side('settle-idempotent');
    await persistSourceBatch(source, { statements: [existing], blocked: [] });
    await setStatuses([{ id: existing.id, status: 'confirmed' }]);
    const durableBefore = structuredClone(rows.statements.get(existing.id));
    const changelogBefore = rows.changelog.size;
    const trustBefore = rows.trustEvents.size;

    await setStatuses([{ id: existing.id, status: 'confirmed' }]);

    expect(rows.statements.get(existing.id)).toEqual(durableBefore);
    expect(rows.changelog.size).toBe(changelogBefore);
    expect(rows.trustEvents.size).toBe(trustBefore);
  });

  it('records superseding as supersede rather than confirm', async () => {
    const existing = side('settle-superseded');
    await persistSourceBatch(source, { statements: [existing], blocked: [] });
    await setStatuses([{ id: existing.id, status: 'superseded' }]);

    expect([...rows.changelog.values()].at(-1)).toMatchObject({
      statementId: existing.id,
      action: 'supersede',
    });
  });
});
