import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildExtractedTripleSchema,
  isSmallOllamaModel,
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_COMPACT
} from '../extractor';
import { extractWithOllama, resolveOllamaSystemPrompt } from '../ollama-extract';

// ── buildExtractedTripleSchema ─────────────────────────────────────────────────

describe('buildExtractedTripleSchema', () => {
  it('describes a top-level JSON array of objects', () => {
    const schema = buildExtractedTripleSchema();
    expect(schema.type).toBe('array');
    expect(schema.items).toBeTruthy();
  });

  it('requires subject, predicate, object on each item', () => {
    const schema = buildExtractedTripleSchema() as { items: { required: string[] } };
    expect(schema.items.required).toEqual(expect.arrayContaining(['subject', 'predicate', 'object']));
  });

  it('includes the excerpt field (rule 10 of the extraction prompt)', () => {
    const schema = buildExtractedTripleSchema() as { items: { properties: Record<string, unknown> } };
    expect(schema.items.properties).toHaveProperty('excerpt');
  });

  it('includes all ExtractedTriple optional fields', () => {
    const schema = buildExtractedTripleSchema() as { items: { properties: Record<string, unknown> } };
    for (const field of ['subject', 'predicate', 'object', 'objectIsLiteral', 'datatype', 'gloss', 'confidence', 'excerpt']) {
      expect(schema.items.properties).toHaveProperty(field);
    }
  });

  it('constrains datatype to the four supported literal types', () => {
    const schema = buildExtractedTripleSchema() as { items: { properties: { datatype: { enum: string[] } } } };
    expect(schema.items.properties.datatype.enum).toEqual(['string', 'number', 'date', 'boolean']);
  });
});

// ── isSmallOllamaModel ──────────────────────────────────────────────────────────

describe('isSmallOllamaModel', () => {
  it('treats explicit ≤4B size tags as small', () => {
    expect(isSmallOllamaModel('llama3.2:3b')).toBe(true);
    expect(isSmallOllamaModel('qwen3:4b')).toBe(true);
  });

  it('treats explicit >4B size tags as not small', () => {
    expect(isSmallOllamaModel('gemma3:27b')).toBe(false);
    expect(isSmallOllamaModel('gpt-oss:20b')).toBe(false);
    expect(isSmallOllamaModel('devstral-small-2')).toBe(false);
  });

  it('falls back to a known-name allowlist when no size suffix is present', () => {
    expect(isSmallOllamaModel('llama3.2')).toBe(true);
  });

  it('treats unrecognized large models without a size tag as not small', () => {
    expect(isSmallOllamaModel('mistral-nemo')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSmallOllamaModel('LLAMA3.2:3B')).toBe(true);
  });
});

// ── resolveOllamaSystemPrompt ────────────────────────────────────────────────────

describe('resolveOllamaSystemPrompt', () => {
  it('picks the compact prompt for small models in auto mode', () => {
    expect(resolveOllamaSystemPrompt({ model: 'llama3.2:3b' })).toBe(EXTRACTION_SYSTEM_PROMPT_COMPACT);
  });

  it('picks the full prompt for large models in auto mode', () => {
    expect(resolveOllamaSystemPrompt({ model: 'devstral-small-2' })).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('forces the compact prompt when promptMode is "compact"', () => {
    expect(resolveOllamaSystemPrompt({ model: 'devstral-small-2', promptMode: 'compact' })).toBe(EXTRACTION_SYSTEM_PROMPT_COMPACT);
  });

  it('forces the full prompt when promptMode is "full"', () => {
    expect(resolveOllamaSystemPrompt({ model: 'llama3.2:3b', promptMode: 'full' })).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('lets systemPromptOverride win over any promptMode', () => {
    const custom = 'CUSTOM SYSTEM PROMPT';
    expect(resolveOllamaSystemPrompt({ model: 'llama3.2:3b', promptMode: 'full', systemPromptOverride: custom })).toBe(custom);
  });
});

// ── extractWithOllama (mocked fetch) ─────────────────────────────────────────────

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  } as Response;
}

const VALID_TRIPLE = { subject: 'alice', predicate: 'knows', object: 'bob' };

describe('extractWithOllama', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls the native /api/chat endpoint with a JSON-schema format when structured (default)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ message: { content: JSON.stringify([VALID_TRIPLE]) } })
    );

    const triples = await extractWithOllama('Alice knows Bob.', 'Test', { model: 'llama3.2:3b' });

    expect(triples).toHaveLength(1);
    expect(triples[0].subject).toBe('alice');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/api/chat');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.format).toBeTruthy();
    expect(body.format.type).toBe('array');
  });

  it('retries once with a repair message when the first structured response fails to parse', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: { content: 'not json at all, no array here' } }))
      .mockResolvedValueOnce(jsonResponse({ message: { content: JSON.stringify([VALID_TRIPLE]) } }));

    const triples = await extractWithOllama('Alice knows Bob.', 'Test', { model: 'llama3.2:3b' });

    expect(triples).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    // The repair turn should reference the invalid prior output and ask again.
    const lastMessage = secondBody.messages[secondBody.messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toMatch(/invalid/i);
  });

  it('falls back to the plain chat endpoint when structured decoding fails twice', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: { content: 'still not json' } }))
      .mockResolvedValueOnce(jsonResponse({ message: { content: 'still not json' } }))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: JSON.stringify([VALID_TRIPLE]) } }] }));

    const triples = await extractWithOllama('Alice knows Bob.', 'Test', { model: 'llama3.2:3b' });

    expect(triples).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const thirdUrl = fetchMock.mock.calls[2][0] as string;
    expect(thirdUrl).toContain('/v1/chat/completions');
  });

  it('uses only the plain chat endpoint when structured is explicitly disabled', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ choices: [{ message: { content: JSON.stringify([VALID_TRIPLE]) } }] })
    );

    const triples = await extractWithOllama('Alice knows Bob.', 'Test', { model: 'llama3.2:3b', structured: false });

    expect(triples).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain('/v1/chat/completions');
  });

  it('sends the compact prompt for small models and the full prompt for large ones', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: JSON.stringify([VALID_TRIPLE]) } }));

    await extractWithOllama('text', 'Test', { model: 'llama3.2:3b' });
    let body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toBe(EXTRACTION_SYSTEM_PROMPT_COMPACT);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(jsonResponse({ message: { content: JSON.stringify([VALID_TRIPLE]) } }));
    await extractWithOllama('text', 'Test', { model: 'devstral-small-2' });
    body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it('honors systemPromptOverride (e.g. repository code-extraction supplement)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ message: { content: JSON.stringify([VALID_TRIPLE]) } }));
    const custom = EXTRACTION_SYSTEM_PROMPT + '\nEXTRA CODE RULES';

    await extractWithOllama('text', 'Test', { model: 'llama3.2:3b', systemPromptOverride: custom });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages[0].content).toBe(custom);
  });
});
