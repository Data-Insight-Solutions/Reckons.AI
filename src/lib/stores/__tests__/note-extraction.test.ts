/**
 * The routing, at the level where it actually costs something: a note that is wholly an
 * instruction must not reach the extractor at all, and a mixed note must send only its prose.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Statement } from '../../rdf/types';
import { CAPTURED_NOTE, TASK_GOAL, TASK_STATE } from '../../rdf/captured-notes';

const graph = { kind: 'iri' as const, value: 'urn:kbase:graph/personal-notes' };

function capturedNote(iri: string, text: string): Statement {
  return {
    id: `st-${iri}`,
    s: { kind: 'iri', value: iri },
    p: { kind: 'iri', value: CAPTURED_NOTE },
    o: { kind: 'literal', value: text },
    g: graph,
    sourceId: 'note-source',
    confidence: 1,
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  };
}

let stored: Statement[] = [];
const ingest = vi.fn(async (input: { body: string }) => ({
  phase: 'done' as const,
  source: { id: 'ingest-source' },
  statements: [
    {
      ...capturedNote('urn:kbase:concept/thing', input.body),
      id: 'extracted',
      p: { kind: 'iri' as const, value: 'urn:kbase:predicate/is-a' },
      g: { kind: 'iri' as const, value: 'urn:kbase:graph/ingested' },
    },
  ],
}));
const addStatements = vi.fn(async (statements: Statement[]) => {
  stored.push(...statements);
});
const setStatus = vi.fn(async () => {});
const allStatements = vi.fn(() => stored);

vi.mock('../ingest.svelte', () => ({ ingest: (i: { body: string }) => ingest(i) }));
vi.mock('../kb.svelte', () => ({
  statements: () => allStatements(),
  addStatements: (s: Statement[]) => addStatements(s),
  setStatus: (...args: unknown[]) => setStatus(...(args as [])),
}));

const { extractCapturedNotes } = await import('../note-extraction.svelte');

const goalOf = () => stored.find((s) => s.p.value === TASK_GOAL)?.o.value;

beforeEach(() => {
  stored = [];
  ingest.mockClear();
  addStatements.mockClear();
});

describe('extractCapturedNotes — instructions', () => {
  const INSTRUCTION =
    'run a research task for new grants or current grants that are, for city, uh, Parks and Rec, ' +
    'that have, uh, childhood activities, uh, like swim team.';

  it('never calls the extractor when the whole note is an instruction', async () => {
    stored = [capturedNote('urn:kbase:concept/note-1', INSTRUCTION)];
    const result = await extractCapturedNotes();

    expect(ingest).not.toHaveBeenCalled();
    expect(result.tasks).toBe(1);
    expect(result.extracted).toBe(0);
    expect(result.outcomes[0].skippedExtraction).toBe(true);
  });

  it('writes the goal verbatim and leaves the task unrunnable', async () => {
    stored = [capturedNote('urn:kbase:concept/note-1', INSTRUCTION)];
    await extractCapturedNotes();

    expect(goalOf()).toBe(INSTRUCTION);
    expect(stored.find((s) => s.p.value === TASK_STATE)?.o.value).toBe('proposed');
  });

  it('still marks the note extracted, so it is not processed twice', async () => {
    stored = [capturedNote('urn:kbase:concept/note-1', INSTRUCTION)];
    await extractCapturedNotes();
    const before = stored.length;

    await extractCapturedNotes();
    expect(stored.length).toBe(before);
  });

  it('sends only the prose when a note mixes a fact and an instruction', async () => {
    stored = [
      capturedNote(
        'urn:kbase:concept/note-2',
        'Orange Logic is a private company. Run research on grants for kids swimming.',
      ),
    ];
    const result = await extractCapturedNotes();

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest.mock.calls[0][0].body).toBe('Orange Logic is a private company.');
    expect(result.tasks).toBe(1);
    expect(goalOf()).toBe('Run research on grants for kids swimming.');
  });

  it('extracts an ordinary note exactly as before', async () => {
    stored = [capturedNote('urn:kbase:concept/note-3', 'Orange Logic is a private company.')];
    const result = await extractCapturedNotes();

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(result.tasks).toBe(0);
    expect(result.extracted).toBe(1);
  });
});
