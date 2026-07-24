/**
 * F107.5 sentinel test: the shareable settings profile must carry NO credential — including
 * ones nested inside objects it passes through (turtleSettings.humeApiKey/humeSecretKey), which
 * is exactly how a key leaked before the recursive redaction pass was added.
 */
import { describe, it, expect, vi } from 'vitest';

const SENTINEL_TOP = 'SENTINEL-TOP-LEVEL-SECRET-do-not-export';
const SENTINEL_NESTED = 'SENTINEL-NESTED-HUME-SECRET-do-not-export';

// backup.ts imports db + getSettings at module load; stub ./db so importing it never constructs
// a real Dexie, and so getSettings returns a settings object seeded with sentinel secrets.
vi.mock('../db', () => ({
  db: {},
  getSettings: async () => ({
    key: 'main',
    // Top-level credentials — must never be in the allowlisted profile.
    claudeApiKey: SENTINEL_TOP,
    humeAiApiKey: SENTINEL_TOP,
    githubToken: SENTINEL_TOP,
    // Public fields that SHOULD survive.
    claudeModel: 'claude-opus',
    ollamaBaseUrl: 'http://localhost:11434',
    humeConfigId: 'cfg-public-id',
    // Nested credentials inside a wholesale-copied object — the real leak.
    turtleSettings: {
      name: 'Shelly',
      humeApiKey: SENTINEL_NESTED,
      humeSecretKey: SENTINEL_NESTED,
      humeConfigId: 'cfg-public-id',
    },
    extensionHighlight: { color: '#f60', apiToken: SENTINEL_NESTED },
  }),
}));

import { buildSettingsProfileJson } from '../backup';

describe('settings profile export — no secret escapes (F107.5)', () => {
  it('contains no sentinel secret anywhere in the serialized profile', async () => {
    const json = await buildSettingsProfileJson();
    expect(json).not.toContain(SENTINEL_TOP);
    expect(json).not.toContain(SENTINEL_NESTED);
  });

  it('still carries the public, shareable settings', async () => {
    const profile = JSON.parse(await buildSettingsProfileJson());
    expect(profile.claudeModel).toBe('claude-opus');
    expect(profile.ollamaBaseUrl).toBe('http://localhost:11434');
    expect(profile.humeConfigId).toBe('cfg-public-id'); // an ID, not a credential
    expect(profile.turtleSettings.name).toBe('Shelly');
    expect(profile.turtleSettings.humeApiKey).toBeUndefined();
    expect(profile.turtleSettings.humeSecretKey).toBeUndefined();
  });
});
