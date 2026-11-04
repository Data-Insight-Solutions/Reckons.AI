import { describe, expect, it } from 'vitest';
import { integrations, type IntegrationView } from '../integrations';

const byId = (result: IntegrationView[], id: string): IntegrationView => result.find((r) => r.id === id)!;

describe('integrations', () => {
  it('never returns a key or token, and shows the n8n host (which is not secret)', () => {
    const result = integrations({ claudeApiKey: 'sk-secret-123', githubToken: 'ghp_secret', n8nBaseUrl: 'https://n8n.example.com/x' });
    const json = JSON.stringify(result);
    expect(json).not.toContain('sk-secret-123');
    expect(json).not.toContain('ghp_secret');
    expect(byId(result, 'claude').configured).toBe(true);
    expect(byId(result, 'github').configured).toBe(true);
    expect(byId(result, 'n8n').configured).toBe(true);
    expect(byId(result, 'n8n').detail).toBe('n8n.example.com');
  });

  it('empty settings: nothing is configured', () => {
    const result = integrations({});
    expect(result.length).toBeGreaterThan(0);
    expect(result.every((r) => r.configured === false)).toBe(true);
  });

  it('a whitespace-only key is not configured', () => {
    expect(byId(integrations({ claudeApiKey: '   ' }), 'claude').configured).toBe(false);
  });

  it('Ollama counts when something is routed to it or local-first is on', () => {
    expect(byId(integrations({ chatBackend: 'ollama' }), 'ollama').configured).toBe(true);
    expect(byId(integrations({ preferLocal: true }), 'ollama').configured).toBe(true);
    expect(byId(integrations({}), 'ollama').configured).toBe(false);
  });
});
