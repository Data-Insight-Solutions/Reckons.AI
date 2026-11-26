import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { silentWav, speakStreaming, standInTts } from '../kokoro-tts';

/**
 * Narration playback (Matt, 2026-11-25: "audio output seems broken ... we obviously need audio tests improved").
 * The bug: a play() the browser refused (NotAllowedError: no click on the page yet, as after a reload or a link
 * that autoplays a story) was swallowed, so every sentence "played" instantly into silence and narration reported
 * success. These tests drive speakStreaming with a stand-in model and a fake audio element; whether the real model
 * loads and sounds right is not tested here and needs a person listening (kpred:needs-human-recheck).
 */
type Fake = { el: HTMLAudioElement; played: boolean };

function fakeAudio(play: (f: Fake) => Promise<void>) {
  const made: Fake[] = [];
  const makeAudio = () => {
    const f = { played: false } as Fake;
    f.el = { playbackRate: 1, volume: 1, onended: null, onerror: null, pause() {}, currentTime: 0,
      play: () => play(f) } as unknown as HTMLAudioElement;
    made.push(f);
    return f.el;
  };
  return { made, makeAudio };
}

const finish = () => new Promise((r) => setTimeout(r, 50));
const notAllowed = () => Object.assign(new Error('play() can only be initiated by a user gesture'), { name: 'NotAllowedError' });

describe('speakStreaming', () => {
  beforeEach(() => {
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('plays every sentence in order, then ends', async () => {
    const { made, makeAudio } = fakeAudio((f) => { f.played = true; queueMicrotask(() => f.el.onended?.(new Event('ended'))); return Promise.resolve(); });
    const ev: string[] = [];
    speakStreaming('One. Two. Three.', { onStart: () => ev.push('start'), onEnd: () => ev.push('end'), onBlocked: () => ev.push('blocked'), onError: () => ev.push('error') },
      { tts: standInTts(), makeAudio });
    await finish();
    expect(made.map((f) => f.played)).toEqual([true, true, true]);
    expect(ev).toEqual(['start', 'end']);
  });

  it('a refused play() is BLOCKED, not success: it stops, says so once, and never reports the end', async () => {
    const { made, makeAudio } = fakeAudio(() => Promise.reject(notAllowed()));
    const ev: string[] = [];
    speakStreaming('One. Two. Three.', { onStart: () => ev.push('start'), onEnd: () => ev.push('end'), onBlocked: () => ev.push('blocked'), onError: () => ev.push('error') },
      { tts: standInTts(), makeAudio });
    await finish();
    expect(ev).toEqual(['start', 'blocked']);
    expect(made).toHaveLength(1); // the second and third sentences are not thrown at a browser that said no
  });

  it('any other play() failure skips that sentence and keeps going (a bad chunk is not a muted browser)', async () => {
    let n = 0;
    const { made, makeAudio } = fakeAudio((f) => {
      if (n++ === 0) return Promise.reject(Object.assign(new Error('decode'), { name: 'NotSupportedError' }));
      f.played = true; queueMicrotask(() => f.el.onended?.(new Event('ended'))); return Promise.resolve();
    });
    const ev: string[] = [];
    speakStreaming('One. Two.', { onEnd: () => ev.push('end'), onBlocked: () => ev.push('blocked') }, { tts: standInTts(), makeAudio });
    await finish();
    expect(made.map((f) => f.played)).toEqual([false, true]);
    expect(ev).toEqual(['end']);
  });

  it('with no model loaded it reports an error rather than pretending to speak', () => {
    const onError = vi.fn();
    speakStreaming('One.', { onError });
    expect(onError).toHaveBeenCalledOnce();
  });

  it('the stand-in voice is a real WAV: RIFF header, 16-bit mono at 24 kHz', async () => {
    const b = silentWav(100);
    expect(b.type).toBe('audio/wav');
    const v = new DataView(await b.arrayBuffer());
    expect(String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(24000);
    expect(b.size).toBe(44 + 2400 * 2);
  });
});
