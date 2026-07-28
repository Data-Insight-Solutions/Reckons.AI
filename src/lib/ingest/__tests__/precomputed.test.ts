import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Source, Statement } from '../../rdf/types';
import {
  commitPrecomputedIngest,
  type PrecomputedIngestDependencies,
} from '../precomputed';

const source: Source = {
  id: 'source-id',
  title: 'Precomputed import',
  uri: 'test://precomputed',
  kind: 'document',
  ingestedAt: 1,
};

const rawStatement: Statement = {
  id: 'raw',
  s: { kind: 'iri', value: 'urn:new-acme' },
  p: { kind: 'iri', value: 'http://www.w3.org/2000/01/rdf-schema#label' },
  o: { kind: 'literal', value: 'Acme Corp' },
  g: { kind: 'iri', value: 'urn:kbase:source/source-id' },
  sourceId: source.id,
  confidence: 1,
  status: 'pending',
  createdAt: 1,
  updatedAt: 1,
};
const normalizedStatement: Statement = {
  ...rawStatement,
  id: 'normalized',
};
const remappedStatement: Statement = {
  ...normalizedStatement,
  id: 'remapped',
  s: { kind: 'iri', value: 'urn:archived-acme' },
};
const existingStatement: Statement = {
  ...rawStatement,
  id: 'existing',
  s: { kind: 'iri', value: 'urn:existing' },
};

function dependencies(): PrecomputedIngestDependencies {
  return {
    currentStatements: vi.fn(() => [existingStatement]),
    normalize: vi.fn(async () => ({
      statements: [normalizedStatement],
      subjectRemaps: 1,
      predicateRemaps: 0,
      remaps: [{
        from: rawStatement.s.value,
        to: normalizedStatement.s.value,
        kind: 'subject' as const,
        similarity: 0.95,
      }],
    })),
    resolveArchiveReferences: vi.fn(async () => ({
      decision: 'restore' as const,
      statements: [remappedStatement],
      references: [],
      restoredEntities: ['urn:archived-acme'],
    })),
    persistSource: vi.fn(async () => undefined),
    persistStatements: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('commitPrecomputedIngest (F97.3)', () => {
  it('normalizes before archive resolution and persists only the resolved batch', async () => {
    const deps = dependencies();

    const result = await commitPrecomputedIngest({
      sourceTitle: source.title,
      source,
      statements: [rawStatement],
    }, deps);

    expect(deps.normalize).toHaveBeenCalledWith([rawStatement], [existingStatement]);
    expect(deps.resolveArchiveReferences).toHaveBeenCalledWith({
      sourceTitle: source.title,
      statements: [normalizedStatement],
    });
    expect(deps.persistSource).toHaveBeenCalledWith(source);
    expect(deps.persistStatements).toHaveBeenCalledWith([remappedStatement], source.id);
    expect(result).toEqual({
      phase: 'done',
      decision: 'restore',
      statements: [remappedStatement],
    });
  });

  it('writes no source or statements when the archive decision is cancel', async () => {
    const deps = dependencies();
    vi.mocked(deps.resolveArchiveReferences).mockResolvedValue({
      decision: 'cancel',
      statements: [normalizedStatement],
      references: [],
      restoredEntities: [],
    });

    const result = await commitPrecomputedIngest({
      sourceTitle: source.title,
      source,
      statements: [rawStatement],
    }, deps);

    expect(result).toEqual({
      phase: 'cancelled',
      reason: 'archive-reference',
    });
    expect(deps.persistSource).not.toHaveBeenCalled();
    expect(deps.persistStatements).not.toHaveBeenCalled();
  });

  it('supports source-less multi-calendar batches without changing statement provenance', async () => {
    const deps = dependencies();

    const result = await commitPrecomputedIngest({
      sourceTitle: 'Google Calendar import',
      statements: [rawStatement],
    }, deps);

    expect(deps.persistSource).not.toHaveBeenCalled();
    expect(deps.persistStatements).toHaveBeenCalledWith([remappedStatement], undefined);
    expect(result.phase).toBe('done');
  });

  it('serializes through persistence so the next batch cannot normalize stale state', async () => {
    const deps = dependencies();
    let releaseFirstWrite: (() => void) | undefined;
    vi.mocked(deps.persistStatements)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseFirstWrite = resolve;
      }))
      .mockResolvedValueOnce(undefined);

    const first = commitPrecomputedIngest({
      sourceTitle: 'First',
      source,
      statements: [rawStatement],
    }, deps);
    await vi.waitFor(() => {
      expect(deps.persistStatements).toHaveBeenCalledTimes(1);
    });

    const second = commitPrecomputedIngest({
      sourceTitle: 'Second',
      source: { ...source, id: 'source-2', title: 'Second' },
      statements: [{ ...rawStatement, id: 'raw-2', sourceId: 'source-2' }],
    }, deps);
    await Promise.resolve();
    expect(deps.normalize).toHaveBeenCalledTimes(1);

    releaseFirstWrite?.();
    await Promise.all([first, second]);
    expect(deps.normalize).toHaveBeenCalledTimes(2);
    expect(deps.persistStatements).toHaveBeenCalledTimes(2);
  });

  it('releases the queue after failure and does not write statements after a source error', async () => {
    const deps = dependencies();
    vi.mocked(deps.persistSource)
      .mockRejectedValueOnce(new Error('source write failed'))
      .mockResolvedValueOnce(undefined);

    await expect(commitPrecomputedIngest({
      sourceTitle: 'Fails',
      source,
      statements: [rawStatement],
    }, deps)).rejects.toThrow('source write failed');
    expect(deps.persistStatements).not.toHaveBeenCalled();

    await expect(commitPrecomputedIngest({
      sourceTitle: 'Recovers',
      source: { ...source, id: 'source-recovered', title: 'Recovers' },
      statements: [{ ...rawStatement, id: 'raw-recovered', sourceId: 'source-recovered' }],
    }, deps)).resolves.toMatchObject({ phase: 'done' });
    expect(deps.persistStatements).toHaveBeenCalledTimes(1);
  });
});
