import { describe, it, expect } from 'vitest';
import { parseSettingsProfile } from '../backup';

// ── parseSettingsProfile ─────────────────────────────────────────────────────

describe('parseSettingsProfile', () => {
  const validProfile = {
    _format: 'reckons-settings-profile',
    _version: 1,
    exportedAt: '2025-01-01T00:00:00.000Z',
    preferredBackend: 'claude',
    claudeModel: 'claude-haiku-4-5-20251001',
    openaiModel: 'gpt-4o-mini',
    geminiModel: 'gemini-2.0-flash',
    ollamaModel: 'llama3.2',
    ollamaBaseUrl: 'http://localhost:11434',
    wasmModel: 'onnx-community/Qwen2.5-0.5B-Instruct',
    openrouterModel: '',
    autoAnalyzeOnImport: false,
    autoAnalyzeIntervalMinutes: 0,
    embeddingThreshold: 0.85,
    autoConfirmHighConfidence: false
  };

  it('parses a valid profile', () => {
    const result = parseSettingsProfile(JSON.stringify(validProfile));
    expect(result).not.toBeNull();
    expect(result?.preferredBackend).toBe('claude');
    expect(result?.claudeModel).toBe('claude-haiku-4-5-20251001');
  });

  it('strips _format, _version, exportedAt from result', () => {
    const result = parseSettingsProfile(JSON.stringify(validProfile));
    expect(result).not.toHaveProperty('_format');
    expect(result).not.toHaveProperty('_version');
    expect(result).not.toHaveProperty('exportedAt');
  });

  it('returns null for wrong _format', () => {
    const bad = { ...validProfile, _format: 'something-else' };
    expect(parseSettingsProfile(JSON.stringify(bad))).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(parseSettingsProfile('not json {')).toBeNull();
  });

  it('returns null for missing _format', () => {
    const { _format, ...rest } = validProfile;
    expect(parseSettingsProfile(JSON.stringify(rest))).toBeNull();
  });

  it('passes through optional fields when present', () => {
    const withOptionals = { ...validProfile, kbTitle: 'My KB', shellyCustomPrompt: 'Be terse.' };
    const result = parseSettingsProfile(JSON.stringify(withOptionals));
    expect(result?.kbTitle).toBe('My KB');
    expect(result?.shellyCustomPrompt).toBe('Be terse.');
  });

  it('does not include API keys even if present in JSON', () => {
    const withKey = { ...validProfile, claudeApiKey: 'synthetic-secret' };
    const result = parseSettingsProfile(JSON.stringify(withKey));
    expect(result).not.toHaveProperty('claudeApiKey');
    expect(result?.preferredBackend).toBe('claude');
  });
});

// ── sendTextToFiles — device sync through the share sheet (2026-09-30) ───────

import { afterEach, vi } from 'vitest';
import { canShareFiles, sendTextToFiles } from '../backup';

describe('sendTextToFiles', () => {
  const realNavigator = globalThis.navigator;
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Object.defineProperty(globalThis, 'navigator', { value: realNavigator, configurable: true });
  });
  const withNavigator = (extra: Record<string, unknown>) =>
    Object.defineProperty(globalThis, 'navigator', { value: { ...realNavigator, ...extra }, configurable: true });
  const stubDownload = () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  };

  it('hands the file to the share sheet where files can be shared', async () => {
    const share = vi.fn(async () => {});
    withNavigator({ canShare: () => true, share });
    const click = stubDownload();
    expect(await sendTextToFiles('@prefix x: <x:> .', 'my-space.ttl')).toBe('shared');
    const arg = (share.mock.calls[0] as unknown as [{ files: File[] }])[0];
    expect(arg.files[0].name).toBe('my-space.ttl');
    expect(arg.files[0].type).toBe('text/turtle');
    expect(click).not.toHaveBeenCalled();
  });

  it('reports a dismissed share sheet as cancelled, and does NOT download behind the user\'s back', async () => {
    const abort = Object.assign(new Error('dismissed'), { name: 'AbortError' });
    withNavigator({ canShare: () => true, share: vi.fn(async () => { throw abort; }) });
    const click = stubDownload();
    expect(await sendTextToFiles('x', 'a.ttl')).toBe('cancelled');
    expect(click).not.toHaveBeenCalled();
  });

  it('downloads where there is no share sheet', async () => {
    withNavigator({ canShare: undefined, share: undefined });
    const click = stubDownload();
    expect(canShareFiles()).toBe(false);
    expect(await sendTextToFiles('x', 'a.ttl')).toBe('downloaded');
    expect(click).toHaveBeenCalledOnce();
  });

  it('falls back to a download when the share sheet refuses for another reason', async () => {
    const denied = Object.assign(new Error('no'), { name: 'NotAllowedError' });
    withNavigator({ canShare: () => true, share: vi.fn(async () => { throw denied; }) });
    const click = stubDownload();
    expect(await sendTextToFiles('x', 'a.ttl')).toBe('downloaded');
    expect(click).toHaveBeenCalledOnce();
  });
});
