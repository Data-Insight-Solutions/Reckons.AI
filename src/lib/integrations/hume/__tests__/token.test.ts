import { describe, it, expect, vi } from 'vitest';
import { planHumeAuth, fetchHumeTokenFromUrl } from '../token';

describe('planHumeAuth (F107.6)', () => {
  it('mints locally when the owner has both keys', () => {
    expect(planHumeAuth({ apiKey: 'k', secretKey: 's', tokenUrl: 'https://x/t' }))
      .toEqual({ method: 'mint-local', apiKey: 'k', secretKey: 's' });
  });

  it('uses the bare api key when there is no secret', () => {
    expect(planHumeAuth({ apiKey: 'k' })).toEqual({ method: 'api-key', apiKey: 'k' });
  });

  it('uses a shared token endpoint only when the caller has no key of their own', () => {
    expect(planHumeAuth({ tokenUrl: 'https://x/t' })).toEqual({ method: 'token-url', tokenUrl: 'https://x/t' });
  });

  it('prefers the caller’s own credentials over a shared endpoint', () => {
    expect(planHumeAuth({ apiKey: 'k', tokenUrl: 'https://x/t' }).method).toBe('api-key');
  });

  it('is "none" when nothing usable is present, ignoring whitespace', () => {
    expect(planHumeAuth({}).method).toBe('none');
    expect(planHumeAuth({ apiKey: '   ', secretKey: '  ', tokenUrl: '' }).method).toBe('none');
  });

  it('never asks the viewer for a secret key (token-url plan carries no secret)', () => {
    const plan = planHumeAuth({ tokenUrl: 'https://x/t' });
    expect(JSON.stringify(plan)).not.toContain('secret');
  });
});

describe('fetchHumeTokenFromUrl', () => {
  const ok = (body: unknown): typeof fetch =>
    (vi.fn(async () => ({ ok: true, status: 200, json: async () => body })) as unknown as typeof fetch);

  it('returns the token for each accepted response shape', async () => {
    expect(await fetchHumeTokenFromUrl('https://x/t', ok({ accessToken: 'A' }))).toBe('A');
    expect(await fetchHumeTokenFromUrl('https://x/t', ok({ access_token: 'B' }))).toBe('B');
    expect(await fetchHumeTokenFromUrl('https://x/t', ok({ token: 'C' }))).toBe('C');
  });

  it('allows http only for localhost (dev), requires https otherwise', async () => {
    await expect(fetchHumeTokenFromUrl('http://evil.example/t', ok({ token: 'X' }))).rejects.toThrow(/https/);
    expect(await fetchHumeTokenFromUrl('http://localhost:8787/t', ok({ token: 'X' }))).toBe('X');
  });

  it('rejects an invalid URL and an empty endpoint', async () => {
    await expect(fetchHumeTokenFromUrl('not a url', ok({ token: 'X' }))).rejects.toThrow(/invalid|https/i);
    await expect(fetchHumeTokenFromUrl('   ', ok({ token: 'X' }))).rejects.toThrow(/no Hume token endpoint/);
  });

  it('surfaces a non-ok status, non-JSON, and a missing token', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(fetchHumeTokenFromUrl('https://x/t', bad)).rejects.toThrow(/503/);

    const notJson = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })) as unknown as typeof fetch;
    await expect(fetchHumeTokenFromUrl('https://x/t', notJson)).rejects.toThrow(/non-JSON/);

    await expect(fetchHumeTokenFromUrl('https://x/t', ok({ nope: 1 }))).rejects.toThrow(/no access token/);
  });

  it('wraps a network failure instead of hanging', async () => {
    const boom = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(fetchHumeTokenFromUrl('https://x/t', boom)).rejects.toThrow(/unreachable/);
  });
});
