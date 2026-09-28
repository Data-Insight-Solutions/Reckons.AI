import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, it, expect, vi } from 'vitest';

const { sentinel, current } = vi.hoisted(() => {
  const sentinel = 'SYNTHETIC-CREDENTIAL-DO-NOT-EXPORT';
  return { sentinel, current: {
    key: 'main', claudeApiKey: sentinel, humeAiApiKey: sentinel, githubToken: sentinel,
    claudeModel: 'example-model', ollamaBaseUrl: 'http://localhost:11434', humeConfigId: 'public-config',
    turtleSettings: {
      name: 'Example helper', humeApiKey: sentinel, humeSecretKey: sentinel,
      humeConfigId: 'public-config', unknownAuthorization: sentinel,
      position: { x: 5, y: 8 }, clickBindings: { single: 'chat', double: 'explore', right: 'menu' },
    },
    extensionHighlight: { conflictColor: '#ff6600', apiToken: sentinel },
  } };
});
vi.mock('../db', () => ({
  DEFAULT_SETTINGS: current,
  db: {
    settings: { get: async () => current },
    statements: { toArray: async () => [] },
    sources: { toArray: async () => [] },
  },
  getSettings: async () => current,
}));

import { buildSettingsProfileJson, exportSettingsProfile, exportKBFull, parseSettingsProfile } from '../backup';
import type { SettingsRecord } from '../db';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('credential boundaries (F107.5)', () => {
  it('workspace profile serialization excludes nested and unknown credentials', async () => {
    const json = await buildSettingsProfileJson();
    expect(json).not.toContain(sentinel);
    const profile = JSON.parse(json);
    expect(profile.claudeModel).toBe('example-model');
    expect(profile.turtleSettings.humeConfigId).toBe('public-config');
    expect(profile.extensionHighlight.conflictColor).toBe('#ff6600');
  });

  it.each([exportSettingsProfile, exportKBFull])('download %s excludes settings credentials', async (download) => {
    vi.stubGlobal('Blob', NodeBlob);
    const blobs: NodeBlob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as unknown as NodeBlob);
      return 'blob:synthetic';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await download();
    expect(blobs).toHaveLength(1);
    const payload = await blobs[0].text();
    expect(payload).not.toContain(sentinel);
    expect(payload).toContain('Example helper');
  });

  it('imports preference patches without replacing top-level or nested credentials', () => {
    const payload = {
      _format: 'reckons-settings-profile', _version: 1,
      key: 'user-defaults', claudeApiKey: 'attacker-value', kbStableId: 'replacement-id',
      turtleSettings: { name: 'New name', humeApiKey: 'attacker-value', humeSecretKey: '', position: { x: 9 } },
      extensionHighlight: { apiToken: 'attacker-value', unknownAuthorization: 'attacker-value' },
    };
    const patch = parseSettingsProfile(JSON.stringify(payload), current as unknown as SettingsRecord);
    expect(patch).not.toHaveProperty('claudeApiKey');
    expect(patch).not.toHaveProperty('key');
    expect(patch).not.toHaveProperty('kbStableId');
    expect(JSON.stringify(patch)).not.toContain('attacker-value');
    expect(patch?.turtleSettings).toMatchObject({ name: 'New name', humeApiKey: sentinel, humeSecretKey: sentinel, position: { x: 9, y: 8 } });
    expect(current.turtleSettings.name).toBe('Example helper');
  });

  it.each([
    { _version: 2 }, { preferredBackend: ['claude'] }, { turtleSettings: [] },
    { turtleSettings: { name: { token: 'unexpected' } } },
    { extensionHighlight: { saturation: '100' } },
    { ollamaBaseUrl: 'https://user:secret@example.test' },
    { ollamaBaseUrl: 'https://example.test/?token=secret' },
  ])('rejects malformed or credential-bearing known fields: %j', (fields) => {
    expect(parseSettingsProfile(JSON.stringify({ _format: 'reckons-settings-profile', _version: 1, ...fields }))).toBeNull();
  });

  it('ignores prototype fields at every depth', () => {
    const json = '{"_format":"reckons-settings-profile","_version":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"turtleSettings":{"__proto__":{"polluted":true},"name":"Clean"}}';
    const patch = parseSettingsProfile(json);
    expect(patch?.turtleSettings?.name).toBe('Clean');
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(JSON.stringify(patch)).not.toContain('polluted');
  });
});
