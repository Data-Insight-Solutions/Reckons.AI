import { describe, it, expect } from 'vitest';
import { recommendDuplicateChoice, describeProbe, type KbProbe } from '../kb-duplicate-choice';

const DAY = 86_400_000;
const T = Date.UTC(2026, 7, 1);

function probe(p: Partial<KbProbe> & { id: string }): KbProbe {
  return {
    name: 'reckons-roadmap',
    exists: true,
    confirmed: 100,
    pending: 0,
    entities: 20,
    lastEditedAt: T,
    ...p,
  };
}

describe('recommendDuplicateChoice', () => {
  it('returns null when there is nothing to choose between', () => {
    expect(recommendDuplicateChoice([probe({ id: 'a' })])).toBeNull();
  });

  it('discards a registry row with no database behind it, and says it costs nothing', () => {
    const out = recommendDuplicateChoice([
      probe({ id: 'real' }),
      probe({ id: 'ghost', exists: false }),
    ])!;
    expect(out.keep.id).toBe('real');
    expect(out.discard.map((d) => d.id)).toEqual(['ghost']);
    expect(out.confidence).toBe('high');
    expect(out.reason).toMatch(/loses nothing/);
  });

  it('keeps the more complete copy when it is also the most recent — signals agree', () => {
    const out = recommendDuplicateChoice([
      probe({ id: 'big', confirmed: 900, lastEditedAt: T }),
      probe({ id: 'small', confirmed: 120, lastEditedAt: T - 30 * DAY }),
    ])!;
    expect(out.keep.id).toBe('big');
    expect(out.confidence).toBe('high');
    expect(out.reason).toMatch(/both signals agree/);
  });

  it('DROPS CONFIDENCE when the newer copy has fewer facts — the dangerous case', () => {
    // This is what a truncated import or a partial edit looks like. Resolving it silently
    // could destroy the only complete version, so it must be surfaced rather than tiebroken.
    const out = recommendDuplicateChoice([
      probe({ id: 'big-old', confirmed: 900, lastEditedAt: T - 30 * DAY }),
      probe({ id: 'small-new', confirmed: 120, lastEditedAt: T }),
    ])!;
    expect(out.keep.id).toBe('big-old');
    expect(out.confidence).toBe('low');
    expect(out.reason).toMatch(/open both before discarding/i);
  });

  it('reports identical copies as an arbitrary choice and keeps the oldest', () => {
    const out = recommendDuplicateChoice([
      probe({ id: 'newer', lastEditedAt: T }),
      probe({ id: 'older', lastEditedAt: T - 10 * DAY }),
    ])!;
    expect(out.identical).toBe(true);
    expect(out.keep.id).toBe('older');
    expect(out.reason).toMatch(/arbitrary/);
  });

  it('never recommends an unreadable copy', () => {
    const out = recommendDuplicateChoice([
      probe({ id: 'broken', confirmed: 9999, error: 'cursor failed' }),
      probe({ id: 'fine', confirmed: 10 }),
    ])!;
    expect(out.keep.id).toBe('fine');
    expect(out.discard.map((d) => d.id)).toContain('broken');
  });

  it('returns null when no copy is readable at all, rather than guessing', () => {
    expect(
      recommendDuplicateChoice([
        probe({ id: 'a', exists: false }),
        probe({ id: 'b', error: 'open failed' }),
      ]),
    ).toBeNull();
  });

  it('breaks a fact-count tie on entity count', () => {
    const out = recommendDuplicateChoice([
      probe({ id: 'fewer-ents', confirmed: 500, entities: 10 }),
      probe({ id: 'more-ents', confirmed: 500, entities: 80 }),
    ])!;
    expect(out.keep.id).toBe('more-ents');
  });

  it('handles three copies, keeping one and discarding the rest', () => {
    const out = recommendDuplicateChoice([
      probe({ id: 'a', confirmed: 10 }),
      probe({ id: 'b', confirmed: 900, lastEditedAt: T }),
      probe({ id: 'c', exists: false }),
    ])!;
    expect(out.keep.id).toBe('b');
    expect(out.discard.map((d) => d.id).sort()).toEqual(['a', 'c']);
  });
});

describe('describeProbe', () => {
  it('names a dangling entry as such rather than showing zeroes', () => {
    expect(describeProbe(probe({ id: 'x', exists: false }))).toMatch(/dangling/);
  });

  it('summarises facts, entities and edit date', () => {
    const s = describeProbe(probe({ id: 'x', confirmed: 42, entities: 7, lastEditedAt: T }));
    expect(s).toMatch(/42 facts/);
    expect(s).toMatch(/7 entities/);
    expect(s).toMatch(/2026-08-01/);
  });

  it('mentions pending only when there are some', () => {
    expect(describeProbe(probe({ id: 'x', pending: 0 }))).not.toMatch(/pending/);
    expect(describeProbe(probe({ id: 'x', pending: 3 }))).toMatch(/3 pending/);
  });
});
