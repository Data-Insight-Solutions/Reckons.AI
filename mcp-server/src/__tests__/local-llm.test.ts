import { describe, it, expect, vi, beforeEach } from 'vitest';

const ollamaChatMock = vi.fn();
const ollamaChatJSONMock = vi.fn();

vi.mock('../ollama-client.js', () => ({
  ollamaChat: (...args: unknown[]) => ollamaChatMock(...args),
  ollamaChatJSON: (...args: unknown[]) => ollamaChatJSONMock(...args),
}));

import { extractTriplesLocally, renderLocalTriplesAsTurtle, summarizeLocally, LOCAL_EXTRACT_SYSTEM_PROMPT } from '../local-llm.js';
import type { SubgraphSource } from '../local-llm.js';
import type { Triple } from '../kb-reader.js';

beforeEach(() => {
  ollamaChatMock.mockReset();
  ollamaChatJSONMock.mockReset();
});

describe('LOCAL_EXTRACT_SYSTEM_PROMPT', () => {
  it('includes the ethics preamble and few-shot examples', () => {
    expect(LOCAL_EXTRACT_SYSTEM_PROMPT).toContain('CONTENT ETHICS');
    expect(LOCAL_EXTRACT_SYSTEM_PROMPT).toContain('Example 1');
    expect(LOCAL_EXTRACT_SYSTEM_PROMPT).toContain('Example 2');
  });
});

describe('extractTriplesLocally', () => {
  it('returns triples + a Turtle rendering on the happy path', async () => {
    ollamaChatJSONMock.mockResolvedValue({
      triples: [
        { subject: 'reckons-ai', predicate: 'ships', object: 'mcp-server', excerpt: 'Reckons.AI ships an MCP server.' },
      ],
    });

    const result = await extractTriplesLocally('Reckons.AI ships an MCP server.', 'test-doc');

    expect(result.triples).toHaveLength(1);
    expect(result.turtle).toContain('kb:reckons-ai kpred:ships kb:mcp-server .');
    expect(ollamaChatJSONMock).toHaveBeenCalledTimes(1);

    const [messages] = ollamaChatJSONMock.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('CONTENT ETHICS');
    expect(messages[1].content).toContain('test-doc');
    expect(messages[1].content).toContain('Reckons.AI ships an MCP server.');
  });

  it('returns an empty triples array when the model yields nothing usable', async () => {
    ollamaChatJSONMock.mockResolvedValue({ triples: [] });
    const result = await extractTriplesLocally('irrelevant text');
    expect(result.triples).toEqual([]);
    expect(result.turtle.trim()).toBe('@prefix kb: <urn:kbase:concept/> .\n@prefix kpred: <urn:kbase:predicate/> .');
  });

  it('propagates errors from the underlying Ollama call (e.g. retry exhausted or disabled)', async () => {
    ollamaChatJSONMock.mockRejectedValue(new Error('Local LLM offload is disabled'));
    await expect(extractTriplesLocally('text')).rejects.toThrow(/disabled/);
  });
});

describe('renderLocalTriplesAsTurtle', () => {
  it('quotes multi-word / numeric objects as literals and slugifies IRIs', () => {
    const turtle = renderLocalTriplesAsTurtle([
      { subject: 'mcp-server', predicate: 'has-tool-count', object: '16' },
      { subject: 'ada lovelace', predicate: 'wrote', object: 'first algorithm' },
    ]);
    expect(turtle).toContain('kb:mcp-server kpred:has-tool-count "16" .');
    expect(turtle).toContain('kb:ada-lovelace kpred:wrote "first algorithm" .');
  });
});

describe('summarizeLocally', () => {
  const fakeTriples: Triple[] = [
    {
      subject: 'urn:kbase:concept/mcp-server',
      predicate: 'urn:kbase:predicate/has-status',
      object: 'production',
      objectIsLiteral: true,
    },
  ];
  const fakeSource: SubgraphSource = {
    resolveLabel: vi.fn((label: string) => (label === 'mcp server' ? 'urn:kbase:concept/mcp-server' : null)),
    subgraph: vi.fn(() => fakeTriples),
  };

  it('summarizes an entity subgraph (pulled via the injected source)', async () => {
    ollamaChatMock.mockResolvedValue('The MCP server is in production.');
    const result = await summarizeLocally({ entity: 'mcp server', budget: 50 }, fakeSource);

    expect(result.label).toBe('mcp-server');
    expect(result.summary).toBe('The MCP server is in production.');
    expect(fakeSource.resolveLabel).toHaveBeenCalledWith('mcp server', undefined);
    expect(fakeSource.subgraph).toHaveBeenCalledWith('urn:kbase:concept/mcp-server', 1, undefined);
  });

  it('accepts a raw IRI directly, skipping resolveLabel', async () => {
    ollamaChatMock.mockResolvedValue('Summary.');
    const result = await summarizeLocally({ entity: 'urn:kbase:concept/mcp-server' }, fakeSource);
    expect(result.label).toBe('mcp-server');
  });

  it('summarizes raw text when text is provided instead of entity', async () => {
    ollamaChatMock.mockResolvedValue('A short summary.');
    const result = await summarizeLocally({ text: 'Some long passage of text to summarize.' }, fakeSource);
    expect(result.label).toBe('provided text');
    expect(result.summary).toBe('A short summary.');
  });

  it('rejects when neither entity nor text is provided', async () => {
    await expect(summarizeLocally({}, fakeSource)).rejects.toThrow(/exactly one/);
  });

  it('rejects when both entity and text are provided', async () => {
    await expect(summarizeLocally({ entity: 'x', text: 'y' }, fakeSource)).rejects.toThrow(/exactly one/);
  });

  it('rejects an unresolvable entity with a helpful message', async () => {
    await expect(summarizeLocally({ entity: 'unknown-thing' }, fakeSource)).rejects.toThrow(/Not found/);
  });

  it('trims an oversized summary down to the word budget', async () => {
    const longSummary = Array.from({ length: 300 }, (_, i) => `word${i}`).join(' ');
    ollamaChatMock.mockResolvedValue(longSummary);
    const result = await summarizeLocally({ text: 'text to summarize', budget: 20 }, fakeSource);
    const words = result.summary.split(/\s+/);
    expect(words.length).toBeLessThanOrEqual(21); // 20 words + trailing ellipsis token
    expect(result.summary.endsWith('…')).toBe(true);
  });
});
