import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractionRun, Source, Statement } from '../../rdf/types';

type Row = { id: string };
const rows = {
  sources: new Map<string, Row>(),
  statements: new Map<string, Row>(),
  extractionRuns: new Map<string, Row>(),
  changelog: new Map<string, Row>(),
};
let failStatementWrite = false;
let changelogSequence = 0;

function table(name: keyof typeof rows) {
  return {
    async put(row: Row) {
      if (name === 'statements' && failStatementWrite) throw new Error('statement write failed');
      rows[name].set(row.id, structuredClone(row));
    },
    async bulkPut(incoming: Row[]) {
      if (name === 'statements' && failStatementWrite) throw new Error('statement write failed');
      for (const row of incoming) rows[name].set(row.id, structuredClone(row));
    },
    async add(row: Row) {
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

const { persistIngestBatch } = await import('../kb.svelte');

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
