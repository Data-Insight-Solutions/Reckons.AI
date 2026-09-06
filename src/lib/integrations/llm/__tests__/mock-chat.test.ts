import { describe, expect, it } from 'vitest';
import { resolveChatProvider, turtleChat } from '../turtle-chat';

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
});
