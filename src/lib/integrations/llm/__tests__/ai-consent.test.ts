/**
 * Shelly must not show a graph to a model before the user agrees.
 *
 * DISTINCT FROM THE DOWNLOAD GATE, and the distinction is the whole point. That gate asks before
 * fetching model WEIGHTS — it is about bytes, and once a model is cached it never fires again.
 * Someone wary of AI is not worried about a 33MB download; they are worried about what the model is
 * shown. Nothing asked about that until 2026-09-18.
 *
 * The check lives at the single entry point rather than at each call site, so a future caller that
 * forgets to ask fails closed instead of quietly sending somebody's notes to a provider.
 */
import { describe, it, expect } from 'vitest';
import { turtleChat, AiConsentRequiredError } from '../turtle-chat';

const context = {
  statementCount: 7,
  sourceCount: 2,
  typesPresent: [],
  untypedEntityCount: 0,
  manualStatementCount: 0,
  sampleEntities: [],
};

const base = {
  provider: 'openai' as const,
  apiKey: 'test-key',
  messages: [{ role: 'user' as const, content: 'hello' }],
  kbContext: context,
};

describe('turtleChat consent gate', () => {
  it('refuses when consent was never asked', async () => {
    await expect(turtleChat({ ...base })).rejects.toBeInstanceOf(AiConsentRequiredError);
  });

  it('refuses when the user declined', async () => {
    await expect(turtleChat({ ...base, consent: 'declined' })).rejects.toBeInstanceOf(AiConsentRequiredError);
  });

  it('refuses BEFORE any network call — absence of consent is a refusal, not a default', async () => {
    let called = false;
    const original = globalThis.fetch;
    globalThis.fetch = (() => { called = true; return Promise.reject(new Error('should not run')); }) as typeof fetch;
    try {
      await expect(turtleChat({ ...base })).rejects.toBeInstanceOf(AiConsentRequiredError);
      expect(called, 'a request was made despite no consent').toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('providers that show the graph to nothing', () => {
  it('does not prompt for the mock backend, which makes no model request', async () => {
    // Asking permission for something that does not happen is the nag that teaches people to
    // click through the prompts that do matter. This exemption broke no existing behaviour —
    // it was found BY an existing test that asserts mock makes no request.
    const r = await turtleChat({ ...base, provider: 'mock', apiKey: '' });
    expect(r.message).toBeTruthy();
  });
});
