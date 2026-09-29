/**
 * The Claude request shape must hold on thinking-always-on models (Claude Opus 5.5).
 *
 * Three ways the old shape broke there, each pinned below: a trailing assistant-turn prefill is a
 * 400; a max_tokens sized for a plain reply is spent on thinking and the reply is cut off; and the
 * first content block is a `thinking` block, so reading by position returns nothing.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { extractWithClaude } from '../claude';
import { claudeMaxTokens, claudeReplyText } from '../providers';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(response: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('extractWithClaude', () => {
  it('asks for structured output instead of prefilling the assistant turn', async () => {
    const fetchMock = stubFetch({
      stop_reason: 'end_turn',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'text', text: '{"triples":[{"subject":"acme","predicate":"has-name","object":"Acme","objectIsLiteral":true,"gloss":"Acme is named Acme.","confidence":0.9,"excerpt":"Acme"}]}' },
      ],
    });

    const triples = await extractWithClaude('Acme', 'Import', { apiKey: 'k', model: 'claude-opus-5-5' });

    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.messages.at(-1).role).toBe('user');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.max_tokens).toBeGreaterThanOrEqual(16_000);
    expect(triples).toEqual([expect.objectContaining({ subject: 'acme', predicate: 'has-name', object: 'Acme' })]);
  });

  it('sends effort only when asked, and reports usage', async () => {
    const reply = { stop_reason: 'end_turn', usage: { input_tokens: 900, output_tokens: 120 }, content: [{ type: 'text', text: '{"triples":[]}' }] };
    const fetchMock = stubFetch(reply);
    const seen: unknown[] = [];

    await extractWithClaude('x', 'y', { apiKey: 'k', model: 'claude-haiku-4-5' });
    await extractWithClaude('x', 'y', { apiKey: 'k', model: 'claude-opus-5-5', effort: 'low', onUsage: (u) => seen.push(u) });

    const bodies = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string));
    expect(bodies[0].output_config).not.toHaveProperty('effort'); // Haiku 4.5 rejects the field
    expect(bodies[1].output_config.effort).toBe('low');
    expect(seen).toEqual([{ input_tokens: 900, output_tokens: 120 }]);
  });

  it('reports a refusal instead of a parse failure', async () => {
    stubFetch({ stop_reason: 'refusal', content: [] });
    await expect(extractWithClaude('x', 'y', { apiKey: 'k' })).rejects.toThrow(/refusal/);
  });
});

describe('claudeMaxTokens', () => {
  it('adds room for thinking only on models that think by default', () => {
    expect(claudeMaxTokens('claude-opus-5-5', 512)).toBe(16_000);
    expect(claudeMaxTokens('claude-sonnet-5', 1024)).toBe(16_000);
    expect(claudeMaxTokens('claude-haiku-4-5-20251001', 512)).toBe(512);
    expect(claudeMaxTokens('claude-opus-4-7', 1024)).toBe(1024);
  });
});

describe('claudeReplyText', () => {
  it('reads text blocks by type, skipping thinking blocks', () => {
    expect(claudeReplyText({ content: [{ type: 'thinking' }, { type: 'text', text: 'hi' }] })).toBe('hi');
  });
});
