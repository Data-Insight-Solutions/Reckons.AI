import { describe, it, expect } from 'vitest';
import { findBakedSecrets } from '../vite-secret-guard.js';

const env = (o: Record<string, string>) => o as unknown as NodeJS.ProcessEnv;

describe('findBakedSecrets — F107.5 VITE secret build guard', () => {
  it('flags VITE_ vars ending in a secret suffix that have a value', () => {
    expect(findBakedSecrets(env({ VITE_ANTHROPIC_API_KEY: 'sk-ant-xxx', VITE_HUME_SECRET_KEY: 'abc' }))).toEqual([
      'VITE_ANTHROPIC_API_KEY',
      'VITE_HUME_SECRET_KEY',
    ]);
  });

  it('ignores config vars and non-VITE vars', () => {
    expect(
      findBakedSecrets(env({ VITE_PREFERRED_BACKEND: 'mock', VITE_INGEST_BACKEND: 'mock', OPENAI_API_KEY: 'sk', PATH: '/bin' }))
    ).toEqual([]);
  });

  it('ignores empty / whitespace-only secret vars (effectively unset)', () => {
    expect(findBakedSecrets(env({ VITE_OPENAI_API_KEY: '', VITE_GEMINI_API_KEY: '   ' }))).toEqual([]);
  });

  it('detects TOKEN and PASSWORD suffixes too', () => {
    expect(findBakedSecrets(env({ VITE_FOO_TOKEN: 't', VITE_BAR_PASSWORD: 'p' }))).toEqual([
      'VITE_BAR_PASSWORD',
      'VITE_FOO_TOKEN',
    ]);
  });
});
