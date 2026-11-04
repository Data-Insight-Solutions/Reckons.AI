import { describe, expect, it } from 'vitest';
import { mockChatReply, resolveChatProvider, turtleChat } from '../turtle-chat';

const context = {
  statementCount: 7,
  sourceCount: 2,
  typesPresent: [],
  untypedEntityCount: 0,
  manualStatementCount: 0,
  sampleEntities: [],
};

describe('mock chat backend', () => {
  it('stays on the keyless mock provider instead of falling through to WASM', () => {
    expect(resolveChatProvider({ preferredBackend: 'mock', chatBackend: 'mock' })).toEqual({
      provider: 'mock',
      apiKey: '',
      model: undefined,
    });
  });

  it('returns a deterministic grounded response without making a model request', async () => {
    const result = await turtleChat({
      provider: 'mock',
      apiKey: '',
      messages: [{ role: 'user', content: 'Help me decide.' }],
      kbContext: context,
    });

    expect(result.message).toContain('7 verified statements');
    expect(result.actions).toEqual([]);
  });

  it('returns a reply a browser test scripted, and only through the mock provider', async () => {
    const g = globalThis as { __RECKONS_MOCK_REPLY__?: string };
    g.__RECKONS_MOCK_REPLY__ = 'OVERVIEW\nA scripted reply.';
    try {
      const result = await turtleChat({
        provider: 'mock',
        apiKey: '',
        messages: [{ role: 'user', content: 'Help me decide.' }],
        kbContext: context,
      });
      expect(result.message).toContain('A scripted reply.');
      expect(mockChatReply(3)).toBe('OVERVIEW\nA scripted reply.');
    } finally {
      delete g.__RECKONS_MOCK_REPLY__;
    }
    expect(mockChatReply(3)).toContain('3 verified');
  });
});
