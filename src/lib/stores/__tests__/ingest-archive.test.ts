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

const addSource = vi.fn();
const addStatements = vi.fn();
const allStatements = vi.fn();
const normalizeEntities = vi.fn();
const resolveArchiveReferencesForIngest = vi.fn();
const computeDiff = vi.fn();
const semanticEnrichDiff = vi.fn();

vi.mock('uuid', () => ({ v4: () => 'source-id' }));
vi.mock('../../integrations/llm/claude', () => ({ extractWithClaude: vi.fn() }));
vi.mock('../../integrations/llm/wasm', () => ({ extractWithWasm: vi.fn() }));
vi.mock('../../integrations/llm/ollama-extract', () => ({ extractWithOllama: vi.fn() }));
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
  parseTriplesJSON: vi.fn(),
  extractMock: vi.fn(() => []),
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
  addSource,
  addStatements,
  statements: allStatements,
}));
vi.mock('../settings.svelte', () => ({
  settings: () => ({ ingestBackend: 'mock', preferredBackend: 'mock' }),
}));
vi.mock('../disambiguation.svelte', () => ({ addSuggestion: vi.fn() }));
vi.mock('../notifications.svelte', () => ({ pushNotification: vi.fn() }));

const { ingest } = await import('../ingest.svelte');

beforeEach(() => {
  vi.clearAllMocks();
  allStatements.mockReturnValue(existingBefore);
  normalizeEntities.mockResolvedValue({
    statements: [normalizedStatement],
    subjectRemaps: 0,
    predicateRemaps: 0,
    remaps: [],
  });
  computeDiff.mockReturnValue({ toAdd: [remappedStatement], toRemove: [], unchanged: [] });
  semanticEnrichDiff.mockResolvedValue({ toAdd: [remappedStatement], toRemove: [], unchanged: [] });
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
    expect(addSource).not.toHaveBeenCalled();
    expect(addStatements).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith(result);
  });

  it('diffs and persists the remapped batch against the refreshed post-restore graph', async () => {
    allStatements
      .mockReturnValueOnce(existingBefore)
      .mockReturnValueOnce(existingAfter);
    resolveArchiveReferencesForIngest.mockResolvedValue({
      decision: 'restore',
      statements: [remappedStatement],
      references: [{ entity: 'urn:acme', label: 'Acme Corp', incoming: [normalizedStatement] }],
      restoredEntities: ['urn:acme'],
    });

    const result = await ingest({ kind: 'note', title: 'Import', body: 'Acme update' });

    expect(normalizeEntities).toHaveBeenCalledWith([rawStatement], existingBefore);
    expect(computeDiff).toHaveBeenCalledWith([remappedStatement], existingAfter);
    expect(semanticEnrichDiff).toHaveBeenCalledWith(
      expect.objectContaining({ toAdd: [remappedStatement] }),
      existingAfter,
    );
    expect(addSource).toHaveBeenCalledTimes(1);
    expect(addStatements).toHaveBeenCalledWith([remappedStatement], 'source-id');
    expect(result).toMatchObject({
      phase: 'done',
      statements: [remappedStatement],
    });
  });
});
