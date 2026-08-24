import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Statement } from '../../rdf/types';

const rawStatement: Statement = {
  id: 'raw',
  s: { kind: 'iri', value: 'urn:new-acme' },
  p: { kind: 'iri', value: 'http://www.w3.org/2000/01/rdf-schema#label' },
  o: { kind: 'literal', value: 'Acme Corp' },
  g: { kind: 'iri', value: 'urn:source' },
  sourceId: 'source-id',
  confidence: 1,
  status: 'pending',
  createdAt: 1,
  updatedAt: 1,
};
const normalizedStatement: Statement = { ...rawStatement, id: 'normalized' };
const remappedStatement: Statement = {
  ...normalizedStatement,
  id: 'remapped',
  s: { kind: 'iri', value: 'urn:acme' },
};
const existingBefore: Statement[] = [{ ...rawStatement, id: 'before', s: { kind: 'iri', value: 'urn:before' } }];
const existingAfter: Statement[] = [{ ...rawStatement, id: 'after', s: { kind: 'iri', value: 'urn:restored' } }];

const prepareStatementsForWrite = vi.fn(async (statements: Statement[]) => ({ statements, blocked: [] }));
const persistIngestBatch = vi.fn(async (_source: unknown, plan: { statements: Statement[] }, _run: unknown) => plan.statements);
const allStatements = vi.fn();
const normalizeEntities = vi.fn();
const resolveArchiveReferencesForIngest = vi.fn();
const computeDiff = vi.fn();
const semanticEnrichDiff = vi.fn();
const saveExtractionRun = vi.fn();
const extractWithClaude = vi.fn();
const extractWithWasm = vi.fn();
const extractWithOllama = vi.fn();
const extractMock = vi.fn(() => [{ subject: 'acme', predicate: 'has-name', object: 'Acme' }]);
let currentSettings: Record<string, unknown> = { ingestBackend: 'mock', preferredBackend: 'mock' };

vi.mock('uuid', () => ({ v4: () => 'source-id' }));
vi.mock('../../integrations/llm/claude', () => ({ extractWithClaude }));
vi.mock('../../integrations/llm/wasm', () => ({ extractWithWasm }));
vi.mock('../../integrations/llm/ollama-extract', () => ({ extractWithOllama }));
vi.mock('../../integrations/llm/providers', () => ({
  chatOpenAI: vi.fn(),
  chatGemini: vi.fn(),
  chatOpenRouter: vi.fn(),
  chatChromeAI: vi.fn(),
  chatReckons: vi.fn(),
}));
vi.mock('../../integrations/llm/extractor', () => ({
  EXTRACTION_SYSTEM_PROMPT: 'system',
  buildExtractionUserPrompt: vi.fn(),
  parseTriplesJSONWithReport: vi.fn(),
  validateExtractedTriples: vi.fn((triples: unknown[]) => ({ triples, rejectedCount: 0 })),
  extractMock,
  triplesToStatements: vi.fn(() => [rawStatement]),
}));
vi.mock('../../integrations/parsers/turtle-url', () => ({ fetchTurtleFromUrl: vi.fn() }));
vi.mock('../../rdf/normalize-entities', () => ({ normalizeEntities }));
vi.mock('../../ingest/archive-reference', () => ({ resolveArchiveReferencesForIngest }));
vi.mock('../../rdf/diff', () => ({ computeDiff }));
vi.mock('../../rdf/semantic-diff', () => ({
  semanticEnrichDiff,
  labelFromIRI: (value: string) => value,
}));
vi.mock('../kb.svelte', () => ({
  prepareStatementsForWrite,
  persistIngestBatch,
  statements: allStatements,
}));
vi.mock('../settings.svelte', () => ({
  settings: () => currentSettings,
}));
vi.mock('../disambiguation.svelte', () => ({ addSuggestion: vi.fn() }));
vi.mock('../notifications.svelte', () => ({ pushNotification: vi.fn() }));
vi.mock('../../storage/extraction-runs', () => ({ saveExtractionRun }));

const { ingest } = await import('../ingest.svelte');

beforeEach(() => {
  vi.clearAllMocks();
  currentSettings = { ingestBackend: 'mock', preferredBackend: 'mock' };
  allStatements.mockReturnValue(existingBefore);
  normalizeEntities.mockResolvedValue({
    statements: [normalizedStatement],
    subjectRemaps: 0,
    predicateRemaps: 0,
    remaps: [],
  });
  // `entries` is part of the real Diff shape; these mocks predate it and asserted only the
  // wiring, so ingest reading entries (F122 'returned' filtering) tripped over the omission.
  computeDiff.mockReturnValue({ toAdd: [remappedStatement], toRemove: [], unchanged: [], entries: [] });
  semanticEnrichDiff.mockResolvedValue({ toAdd: [remappedStatement], toRemove: [], unchanged: [], entries: [] });
});

describe('ingest archive decision boundary (F97.3)', () => {
  it('checks the normalized batch and cancellation writes nothing', async () => {
    resolveArchiveReferencesForIngest.mockResolvedValue({
      decision: 'cancel',
      statements: [normalizedStatement],
      references: [{ entity: 'urn:acme', label: 'Acme Corp', incoming: [normalizedStatement] }],
      restoredEntities: [],
    });
    const progress = vi.fn();

    const result = await ingest({ kind: 'note', title: 'Import', body: 'Acme update' }, progress);

    expect(resolveArchiveReferencesForIngest).toHaveBeenCalledWith(expect.objectContaining({
      sourceTitle: 'Import',
      statements: [normalizedStatement],
    }));
    expect(result).toEqual({ phase: 'cancelled', reason: 'archive-reference' });
    expect(computeDiff).not.toHaveBeenCalled();
    expect(semanticEnrichDiff).not.toHaveBeenCalled();
    expect(prepareStatementsForWrite).not.toHaveBeenCalled();
    expect(persistIngestBatch).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(result);
  });

  it('diffs and persists the remapped batch against the refreshed post-restore graph', async () => {
    allStatements
      // F136.3 added a THIRD read of the graph, and it comes FIRST: grounding the extraction prompt
      // has to see the graph BEFORE extraction, whereas the two reads below happen after it (once
      // to normalize against, once refreshed after an archive restore). Ordering matters here, so
      // the grounding read is given its own value rather than being folded into the next one.
      .mockReturnValueOnce(existingBefore)
      .mockReturnValueOnce(existingBefore)
      .mockReturnValueOnce(existingAfter);
    resolveArchiveReferencesForIngest.mockResolvedValue({
      decision: 'restore',
      statements: [remappedStatement],
      references: [{ entity: 'urn:acme', label: 'Acme Corp', incoming: [normalizedStatement] }],
      restoredEntities: ['urn:acme'],
    });

    const result = await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });

    expect(normalizeEntities).toHaveBeenCalledWith([
      expect.objectContaining({ ...rawStatement, extractionRunId: 'source-id' }),
    ], existingBefore);
    expect(computeDiff).toHaveBeenCalledWith([remappedStatement], existingAfter);
    expect(semanticEnrichDiff).toHaveBeenCalledWith(
      expect.objectContaining({ toAdd: [remappedStatement] }),
      existingAfter,
    );
    expect(prepareStatementsForWrite).toHaveBeenCalledWith([remappedStatement], 'source-id');
    expect(persistIngestBatch).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'source-id' }),
      expect.objectContaining({ statements: [remappedStatement] }),
      expect.objectContaining({ status: 'succeeded', outputStatementIds: ['remapped'] }),
    );
    expect(result).toMatchObject({
      phase: 'done',
      statements: [remappedStatement],
    });
  });

  it('does not persist a statement the user already settled, however often it is re-read (F122)', async () => {
    // Classifying a re-offered rejection as 'returned' stops it READING as news; declining to
    // store it is what stops a fresh row accruing on every poll of an unchanged source.
    allStatements.mockReturnValue(existingAfter);
    resolveArchiveReferencesForIngest.mockResolvedValue({
      decision: 'proceed',
      statements: [remappedStatement],
      references: [],
      restoredEntities: [],
    });
    const returnedDiff = {
      toAdd: [remappedStatement],
      toRemove: [],
      unchanged: [],
      entries: [
        {
          kind: 'returned',
          incoming: remappedStatement,
          existing: [{ ...remappedStatement, id: 'already-rejected', status: 'rejected' }],
          priorStatus: 'rejected',
        },
      ],
    };
    computeDiff.mockReturnValue(returnedDiff);
    semanticEnrichDiff.mockResolvedValue(returnedDiff);

    await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });

    expect(prepareStatementsForWrite).toHaveBeenCalledWith([], 'source-id');
    expect(persistIngestBatch).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ statements: [] }),
      expect.anything(),
    );
  });

  it('keeps the failed WASM primary and actual placeholder producer distinct', async () => {
    currentSettings = { ingestBackend: 'wasm', preferredBackend: 'wasm', wasmModel: 'small-local-model' };
    extractWithWasm.mockRejectedValue(new Error('ONNX unavailable'));
    normalizeEntities.mockImplementation(async (incoming: Statement[]) => ({
      statements: incoming, subjectRemaps: 0, predicateRemaps: 0, remaps: [],
    }));
    resolveArchiveReferencesForIngest.mockResolvedValue({
      decision: 'proceed', statements: [rawStatement], references: [], restoredEntities: [],
    });

    await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });

    expect(persistIngestBatch).toHaveBeenCalledWith(expect.objectContaining({
      extractionBackend: 'mock', extractionModel: 'placeholder-extractor-v1',
    }), expect.anything(), expect.anything());
    const terminalRun = persistIngestBatch.mock.calls.at(-1)![2] as any;
    expect(terminalRun.route.attempts).toEqual([
      expect.objectContaining({ backend: 'wasm', model: 'small-local-model', status: 'failed' }),
      expect.objectContaining({ backend: 'mock', model: 'placeholder-extractor-v1', status: 'succeeded' }),
    ]);
  });

  it('threads graph grounding through the Claude, Ollama, and WASM adapters', async () => {
    resolveArchiveReferencesForIngest.mockResolvedValue({
      decision: 'proceed', statements: [rawStatement], references: [], restoredEntities: [],
    });
    extractWithClaude.mockResolvedValue([{ subject: 'acme', predicate: 'has-name', object: 'Acme' }]);
    extractWithOllama.mockResolvedValue([{ subject: 'acme', predicate: 'has-name', object: 'Acme' }]);
    extractWithWasm.mockResolvedValue([{ subject: 'acme', predicate: 'has-name', object: 'Acme' }]);

    currentSettings = { ingestBackend: 'claude', preferredBackend: 'claude', claudeApiKey: 'test', claudeModel: 'test' };
    await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });
    expect(extractWithClaude).toHaveBeenCalledWith('Acme update', 'Import', expect.objectContaining({
      graphContext: expect.stringContaining('This graph already contains'),
    }));

    currentSettings = { ingestBackend: 'ollama', preferredBackend: 'ollama', ollamaModel: 'test' };
    await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });
    expect(extractWithOllama).toHaveBeenCalledWith('Acme update', 'Import', expect.objectContaining({
      graphContext: expect.stringContaining('This graph already contains'),
    }));

    currentSettings = { ingestBackend: 'wasm', preferredBackend: 'wasm', wasmModel: 'test' };
    await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });
    expect(extractWithWasm).toHaveBeenCalledWith(
      'Acme update', 'Import', 'test', expect.stringContaining('This graph already contains'),
    );
  });

  it('records only statements the shared write funnel actually accepted as run output', async () => {
    normalizeEntities.mockImplementation(async (incoming: Statement[]) => ({
      statements: incoming, subjectRemaps: 0, predicateRemaps: 0, remaps: [],
    }));
    resolveArchiveReferencesForIngest.mockResolvedValue({
      decision: 'proceed', statements: [rawStatement], references: [], restoredEntities: [],
    });
    prepareStatementsForWrite.mockResolvedValueOnce({ statements: [], blocked: [] });

    await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });

    const terminalRun = persistIngestBatch.mock.calls.at(-1)![2] as any;
    expect(terminalRun.candidateStatementCount).toBe(1);
    expect(terminalRun.outputStatementIds).toEqual([]);
  });

  it('records an empty provider result as a validate-stage failure before graph writes', async () => {
    extractMock.mockReturnValueOnce([]);

    await expect(ingest({ kind: 'note', title: 'Empty result', body: 'Acme update' }))
      .rejects.toThrow('Extraction produced no usable triples');

    expect(prepareStatementsForWrite).not.toHaveBeenCalled();
    expect(persistIngestBatch).not.toHaveBeenCalled();
    const terminalRun = saveExtractionRun.mock.calls.at(-1)?.[0];
    expect(terminalRun).toMatchObject({
      status: 'failed',
      failure: expect.objectContaining({ stage: 'validate' }),
      validationCounts: expect.objectContaining({ candidates: 0, accepted: 0, rejected: 0 }),
    });
  });
});
