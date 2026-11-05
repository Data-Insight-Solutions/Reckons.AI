import { describe, expect, it } from 'vitest';
import { cacheKey, holdMs, MIN_HOLD_MS, PAD_MS, planNarration, type NarrationDeps } from '../narration-plan';

/** F275.2 — the narration plan, with synthesis, probing and files injected. */
const VOICE = 'hume:a623d3ed-612c-413b-b09f-e0a379a317f0';

function deps(files: Record<string, Uint8Array> = {}, opts: { fail?: boolean } = {}) {
  const synthCalls: { text: string; voice: string }[] = [];
  const d: NarrationDeps = {
    overrideDir: '/rec',
    cacheDir: '/cache',
    exists: (p) => p in files,
    readFile: (p) => files[p],
    writeFile: (p, b) => { files[p] = b; },
    synth: async (text, voice) => {
      synthCalls.push({ text, voice });
      if (opts.fail) throw new Error('HTTP 401');
      return new TextEncoder().encode(`mp3:${voice}:${text}`);
    },
    probeDurationMs: async (p) => 1000 + files[p].length,
  };
  return { d, files, synthCalls };
}

describe('cacheKey and holdMs', () => {
  it('keys on the whole provider-qualified voice and the trimmed text', () => {
    expect(cacheKey(VOICE, ' Hello. ')).toBe(cacheKey(VOICE, 'Hello.'));
    expect(cacheKey(VOICE, 'Hello.')).not.toBe(cacheKey('other:x', 'Hello.'));
    expect(cacheKey(VOICE, 'Hello.')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('holds a silent step for the minimum and a narrated one for its line plus a pause', () => {
    expect(holdMs(null)).toBe(MIN_HOLD_MS);
    expect(holdMs(100)).toBe(MIN_HOLD_MS);
    expect(holdMs(5000)).toBe(5000 + PAD_MS);
  });
});

describe('planNarration', () => {
  it('synthesizes a new line once, then serves it from the cache', async () => {
    const { d, files, synthCalls } = deps();
    const first = await planNarration('wf', [{ id: 'a', narration: 'Hello.' }], VOICE, d);
    expect(first.clips[0].source).toBe('synthesized');
    expect(synthCalls).toHaveLength(1);
    expect(files[first.clips[0].path]).toBeDefined();
    const again = await planNarration('wf', [{ id: 'a', narration: 'Hello.' }], VOICE, d);
    expect(again.clips[0].source).toBe('cache');
    expect(synthCalls).toHaveLength(1);
  });

  it('synthesizes again when the line or the voice changes', async () => {
    const { d, synthCalls } = deps();
    await planNarration('wf', [{ id: 'a', narration: 'Hello.' }], VOICE, d);
    await planNarration('wf', [{ id: 'a', narration: 'Hello there.' }], VOICE, d);
    await planNarration('wf', [{ id: 'a', narration: 'Hello there.' }], 'other:v', d);
    expect(synthCalls.map((c) => c.text + '|' + c.voice)).toEqual(['Hello.|' + VOICE, 'Hello there.|' + VOICE, 'Hello there.|other:v']);
  });

  it("uses Matt's recording over cache and synthesis, and says so", async () => {
    const { d, synthCalls } = deps({ '/rec/wf/a.wav': new Uint8Array([1, 2, 3]) });
    const { clips } = await planNarration('wf', [{ id: 'a', narration: 'Hello.' }], VOICE, d);
    expect(clips[0]).toMatchObject({ source: 'recorded', voice: 'recorded', path: '/rec/wf/a.wav', durationMs: 1003 });
    expect(clips[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(synthCalls).toHaveLength(0);
  });

  it('gives a step without narration no clip and lists it as silent, in order', async () => {
    const { d } = deps();
    const r = await planNarration('wf', [{ id: 'a', narration: null }, { id: 'b', narration: 'Hi.' }, { id: 'c', narration: '  ' }], VOICE, d);
    expect(r.clips.map((c) => c.stepId)).toEqual(['b']);
    expect(r.silent).toEqual(['a', 'c']);
  });

  it('stops on a synthesis failure and names the step, never leaving a silent gap', async () => {
    const { d } = deps({}, { fail: true });
    await expect(planNarration('wf', [{ id: 'intro', narration: 'Hi.' }], VOICE, d)).rejects.toThrow(/step "intro" failed: HTTP 401/);
  });
});
