import { describe, expect, it } from 'vitest';
import { buildBlind, normalizeForWer, numberToWords, seededShuffle, wer } from '../narration-bench-lib';

describe('narration bench: word error rate', () => {
  it('normalizes case, punctuation, apostrophes and digits', () => {
    expect(normalizeForWer("Hello, World! It's 42.")).toEqual(['hello', 'world', 'its', 'forty', 'two']);
    expect(numberToWords(115)).toBe('one hundred fifteen');
  });
  it('is zero for identical text modulo formatting', () => {
    expect(wer('Where did each of these files come from?', 'where did each of these files come from')).toBe(0);
  });
  it('counts substitutions, deletions and insertions', () => {
    expect(wer('a b c d', 'a x c d')).toBeCloseTo(0.25);
    expect(wer('a b c d', 'a b d')).toBeCloseTo(0.25);
    expect(wer('a b', 'a b c c')).toBeCloseTo(1);
  });
});

describe('narration bench: blind manifest', () => {
  const lines = [{ id: 's1', text: 'one' }, { id: 's2', text: 'two' }, { id: 's3', text: 'three' }];
  const arms = ['kokoro', 'tada-3b', 'tada-1b'];
  const file = (l: string, a: string) => `${a}/${l}.mp3`;
  const ref = (l: string) => `hume-ref/${l}.mp3`;

  it('shuffles deterministically for a seed and differently for another', () => {
    expect(seededShuffle([1, 2, 3, 4, 5, 6], 7)).toEqual(seededShuffle([1, 2, 3, 4, 5, 6], 7));
    expect(seededShuffle([1, 2, 3, 4, 5, 6], 7)).not.toEqual(seededShuffle([1, 2, 3, 4, 5, 6], 8));
  });
  it('is reproducible from its seed', () => {
    expect(buildBlind(lines, arms, file, ref, 42)).toEqual(buildBlind(lines, arms, file, ref, 42));
  });
  it('keeps arm names out of the blind file and recoverable from the key', () => {
    const { blind, key } = buildBlind(lines, arms, file, ref, 42);
    const text = JSON.stringify(blind.entries.map((e) => ({ ...e, clips: e.clips.map((c) => c.label) })));
    for (const a of arms) expect(text).not.toContain(a);
    for (const e of blind.entries) {
      expect(e.clips.map((c) => c.label)).toEqual(['A', 'B', 'C']);
      const k = key.entries.find((x) => x.lineId === e.lineId)!;
      expect(Object.values(k.labels).sort()).toEqual([...arms].sort());
    }
  });
});
