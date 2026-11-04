/**
 * F279: a chosen Ollama model that is not installed is replaced by the best installed one, and the
 * person is told (Matt, 2026-11-04: "make it a notification, need some notice"). These tests run
 * the real resolver and the real notification store; only the installed list is synthetic.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { ollamaModelFor, setOllamaSubstitutionListener } from '$lib/integrations/llm/model-for-task';
import { initOllamaModelNotice, substitutionNotice } from '../ollama-model-notice';
import { notifications, dismissNotification, setNotificationsSuppressed } from '../notifications.svelte';

const INSTALLED = ['llama3.2:3b', 'mistral-small3.2:24b', 'nomic-embed-text:latest'];

beforeEach(() => {
  setNotificationsSuppressed(false);
  for (const n of [...notifications()]) dismissNotification(n.id);
  initOllamaModelNotice();
});
afterAll(() => setOllamaSubstitutionListener(null));

describe('substitution notice', () => {
  it('a chosen model that is not installed raises one important warning naming both models', () => {
    expect(ollamaModelFor('ingest', { ollamaModel: 'qwen3:32b' }, INSTALLED)).toBe('mistral-small3.2:24b');
    const shown = notifications().filter((n) => n.id.startsWith('ollama-substituted:'));
    expect(shown).toHaveLength(1);
    expect(shown[0].type).toBe('warn');
    expect(shown[0].important).toBe(true);
    expect(shown[0].title).toContain('mistral-small3.2:24b');
    expect(shown[0].title).toContain('qwen3:32b');
    expect(shown[0].body).toContain('ollama pull qwen3:32b');
    expect(shown[0].action?.href).toBe('/settings#s-ollama');
  });

  it('shows once per chosen → used pair, however many times the model is resolved', () => {
    for (let i = 0; i < 5; i++) ollamaModelFor('analyze', { ollamaModel: 'phi4:14b-missing' }, INSTALLED);
    dismissNotification(substitutionNotice({ task: 'analyze', chosen: 'phi4:14b-missing', used: 'mistral-small3.2:24b' }).id);
    ollamaModelFor('analyze', { ollamaModel: 'phi4:14b-missing' }, INSTALLED);
    expect(notifications().filter((n) => n.id.includes('phi4:14b-missing'))).toHaveLength(0);
  });

  it('no notice when the chosen model is installed, resolves by family, or nothing was chosen', () => {
    ollamaModelFor('chat', { ollamaModel: 'mistral-small3.2:24b' }, INSTALLED);
    ollamaModelFor('chat', { ollamaModel: 'llama3.2' }, INSTALLED);
    ollamaModelFor('chat', {}, INSTALLED);
    expect(notifications().filter((n) => n.id.startsWith('ollama-substituted:'))).toHaveLength(0);
  });

  it('no notice without an installed list (server not probed): the chosen name runs as before', () => {
    expect(ollamaModelFor('ingest', { ollamaModel: 'not-pulled-yet' }, null)).toBe('not-pulled-yet');
    expect(notifications().filter((n) => n.id.startsWith('ollama-substituted:'))).toHaveLength(0);
  });

  it('names the task in words a person recognises', () => {
    expect(substitutionNotice({ task: 'diffSummary', chosen: 'a', used: 'b' }).body).toContain('change summaries');
  });
});
