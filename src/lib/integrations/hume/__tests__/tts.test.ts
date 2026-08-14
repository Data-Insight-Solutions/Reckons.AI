import { describe, it, expect, vi } from 'vitest';
import {
  resolveHumeTtsAuth,
  shouldNarrateWithHume,
  synthesizeHumeSpeech,
  base64ToBlob,
  HUME_TTS_ENDPOINT,
} from '../tts';
import type { HumeAuthPlan } from '../token';

const AUTH = { header: 'X-Hume-Api-Key', value: 'k' };
// "hi" in base64 — enough to prove decoding without shipping a real clip.
const AUDIO_B64 = 'aGk=';

const jsonRes = (body: unknown, ok = true, status = 200): typeof fetch =>
  vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;

describe('shouldNarrateWithHume — the routing decision (F5.1)', () => {
  const withKey: HumeAuthPlan = { method: 'api-key', apiKey: 'k' };
  const none: HumeAuthPlan = { method: 'none' };

  it('narrates with Hume only when the persona chose it AND auth exists', () => {
    expect(shouldNarrateWithHume('hume', withKey)).toBe(true);
    expect(shouldNarrateWithHume('hume', none)).toBe(false);   // chosen but unusable → local voice
    expect(shouldNarrateWithHume('tts', withKey)).toBe(false); // local voice chosen
    expect(shouldNarrateWithHume(undefined, withKey)).toBe(false);
  });

  it('accepts the shared delegated endpoint as usable auth', () => {
    expect(shouldNarrateWithHume('hume', { method: 'token-url', tokenUrl: 'https://x/t' })).toBe(true);
  });
});

describe('resolveHumeTtsAuth', () => {
  it('sends an owned key as the api-key header', async () => {
    expect(await resolveHumeTtsAuth({ method: 'api-key', apiKey: 'k' })).toEqual({
      header: 'X-Hume-Api-Key', value: 'k',
    });
    expect(await resolveHumeTtsAuth({ method: 'mint-local', apiKey: 'k', secretKey: 's' })).toEqual({
      header: 'X-Hume-Api-Key', value: 'k',
    });
  });

  it('exchanges a delegated endpoint for a short-lived bearer token', async () => {
    const auth = await resolveHumeTtsAuth(
      { method: 'token-url', tokenUrl: 'https://x/t' },
      jsonRes({ accessToken: 'TOK' })
    );
    expect(auth).toEqual({ header: 'Authorization', value: 'Bearer TOK' });
  });

  it('returns null when there is nothing usable', async () => {
    expect(await resolveHumeTtsAuth({ method: 'none' })).toBeNull();
  });
});

describe('synthesizeHumeSpeech', () => {
  it('posts the utterance and decodes the returned audio', async () => {
    const f = jsonRes({ generations: [{ audio: AUDIO_B64 }] });
    const blob = await synthesizeHumeSpeech({ text: 'Hello', auth: AUTH, voiceId: 'v1', fetchImpl: f });

    expect(blob.type).toBe('audio/mpeg');
    expect(blob.size).toBeGreaterThan(0);

    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(url).toBe(HUME_TTS_ENDPOINT);
    const sent = JSON.parse(String(init.body));
    expect(sent.utterances[0].text).toBe('Hello');
    expect(sent.utterances[0].voice).toEqual({ id: 'v1' });
    expect((init.headers as Record<string, string>)['X-Hume-Api-Key']).toBe('k');
  });

  it('accepts the alternate audio field names', async () => {
    for (const body of [{ audio: AUDIO_B64 }, { audioBase64: AUDIO_B64 }, { audio_base64: AUDIO_B64 }]) {
      const blob = await synthesizeHumeSpeech({ text: 'x', auth: AUTH, fetchImpl: jsonRes(body) });
      expect(blob.size).toBeGreaterThan(0);
    }
  });

  it('THROWS on every failure so the caller can fall back to the local voice', async () => {
    await expect(synthesizeHumeSpeech({ text: '  ', auth: AUTH, fetchImpl: jsonRes({}) }))
      .rejects.toThrow(/nothing to narrate/);

    await expect(synthesizeHumeSpeech({ text: 'x', auth: AUTH, fetchImpl: jsonRes({}, false, 401) }))
      .rejects.toThrow(/401/);

    await expect(synthesizeHumeSpeech({ text: 'x', auth: AUTH, fetchImpl: jsonRes({ generations: [] }) }))
      .rejects.toThrow(/no audio/);

    const notJson = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad'); } })) as unknown as typeof fetch;
    await expect(synthesizeHumeSpeech({ text: 'x', auth: AUTH, fetchImpl: notJson }))
      .rejects.toThrow(/non-JSON/);

    const boom = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(synthesizeHumeSpeech({ text: 'x', auth: AUTH, fetchImpl: boom }))
      .rejects.toThrow(/unreachable/);
  });

  it('omits the voice field when the persona names none', async () => {
    const f = jsonRes({ audio: AUDIO_B64 });
    await synthesizeHumeSpeech({ text: 'x', auth: AUTH, fetchImpl: f });
    const [, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0];
    expect(JSON.parse(String(init.body)).utterances[0].voice).toBeUndefined();
  });
});

describe('base64ToBlob', () => {
  it('decodes bare base64 and a data: URI alike', async () => {
    expect(await base64ToBlob(AUDIO_B64, 'audio/mpeg').text()).toBe('hi');
    expect(await base64ToBlob(`data:audio/mpeg;base64,${AUDIO_B64}`, 'audio/mpeg').text()).toBe('hi');
  });
});
