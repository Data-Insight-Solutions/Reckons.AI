import { describe, it, expect } from 'vitest';
import { redactSecrets, isSecretKey } from '../redact';

describe('isSecretKey (F107.5)', () => {
  it('flags credential-shaped field names', () => {
    for (const k of [
      'apiKey', 'claudeApiKey', 'humeApiKey', 'humeSecretKey', 'secretKey',
      'openrouterApiKey', 'githubToken', 'indicoApiToken', 'password', 'accessKey',
      'privateKey', 'sessionToken', 'bearer', 'credentials', 'meshy_api_key',
    ]) {
      expect(isSecretKey(k), k).toBe(true);
    }
  });

  it('does NOT flag ids, urls, models, or ordinary settings', () => {
    for (const k of [
      'humeConfigId', 'googleClientId', 'kbStableId', 'ollamaBaseUrl', 'claudeModel',
      'kbTitle', 'embeddingThreshold', 'uiScale', 'keyboardShortcut', 'tokenizerName',
    ]) {
      expect(isSecretKey(k), k).toBe(false);
    }
  });
});

describe('redactSecrets', () => {
  it('drops secret fields at the top level', () => {
    const out = redactSecrets({ claudeApiKey: 'sk-live-123', claudeModel: 'opus' });
    expect(out).toEqual({ claudeModel: 'opus' });
  });

  it('drops secret fields nested at any depth (the real leak)', () => {
    const out = redactSecrets({
      turtleSettings: { name: 'Shelly', humeApiKey: 'HUME-SECRET', humeSecretKey: 'HUME-SECRET-2', humeConfigId: 'cfg-ok' },
    }) as { turtleSettings: Record<string, unknown> };
    expect(out.turtleSettings.name).toBe('Shelly');
    expect(out.turtleSettings.humeConfigId).toBe('cfg-ok');
    expect('humeApiKey' in out.turtleSettings).toBe(false);
    expect('humeSecretKey' in out.turtleSettings).toBe(false);
  });

  it('walks arrays of objects', () => {
    const out = redactSecrets({ sessions: [{ id: '1', token: 'T1' }, { id: '2', token: 'T2' }] }) as {
      sessions: Record<string, unknown>[];
    };
    expect(out.sessions.map((s) => s.id)).toEqual(['1', '2']);
    expect(out.sessions.every((s) => !('token' in s))).toBe(true);
  });

  it('does not mutate the input', () => {
    const input = { apiKey: 'secret', keep: 1 };
    redactSecrets(input);
    expect(input.apiKey).toBe('secret');
  });
});
