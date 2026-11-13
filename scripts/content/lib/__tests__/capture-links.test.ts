import { describe, expect, it } from 'vitest';
import { components, gapsFor, linkTable, type PairMatch } from '../capture-links';

// Synthetic capture ids only: nothing here comes from a real capture (the done-test
// requires no private capture in any test).

const TARGET = 'fused-room-target';
const GAP_TEXT = 'These captures do not overlap enough to join; a pass that sees both areas is needed';

describe('linkTable', () => {
  it('is symmetric: both directions of a pair carry the same count', () => {
    const table = linkTable(['cap-a', 'cap-b'], [{ a: 'cap-a', b: 'cap-b', verified: 500 }]);
    expect(table.get('cap-a')!.get('cap-b')).toBe(500);
    expect(table.get('cap-b')!.get('cap-a')).toBe(500);
  });

  it('is symmetric even when the row names the pair in the other order', () => {
    const table = linkTable(['cap-a', 'cap-b'], [{ a: 'cap-b', b: 'cap-a', verified: 500 }]);
    expect(table.get('cap-a')!.get('cap-b')).toBe(500);
    expect(table.get('cap-b')!.get('cap-a')).toBe(500);
  });

  it('fills every distinct pair, 0 where no match was given', () => {
    const table = linkTable(['cap-a', 'cap-b', 'cap-c'], [{ a: 'cap-a', b: 'cap-b', verified: 500 }]);
    expect(table.get('cap-a')!.get('cap-c')).toBe(0);
    expect(table.get('cap-c')!.get('cap-a')).toBe(0);
    expect(table.get('cap-b')!.get('cap-c')).toBe(0);
    expect(table.get('cap-c')!.get('cap-b')).toBe(0);
  });

  it('ignores a self-pair and a row naming a capture that is not in the list', () => {
    const table = linkTable(['cap-a', 'cap-b'], [
      { a: 'cap-a', b: 'cap-a', verified: 999 },
      { a: 'cap-a', b: 'cap-missing', verified: 999 },
    ]);
    expect(table.get('cap-a')!.get('cap-b')).toBe(0);
  });
});

describe('components + gapsFor (the gap rule)', () => {
  it('two captures with 500 links at a minimum of 30 give one group and no gap', () => {
    const table = linkTable(['cap-a', 'cap-b'], [{ a: 'cap-a', b: 'cap-b', verified: 500 }]);
    const groups = components(table, 30);
    expect(groups).toHaveLength(1);
    expect(groups[0].slice().sort()).toEqual(['cap-a', 'cap-b']);
    expect(gapsFor(groups, TARGET)).toEqual([]);
  });

  it('with the links removed they give two groups and one gap naming both', () => {
    const table = linkTable(['cap-a', 'cap-b'], []);
    const groups = components(table, 30);
    expect(groups).toHaveLength(2);
    const gaps = gapsFor(groups, TARGET);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].between).toEqual([['cap-a'], ['cap-b']]);
    expect(gaps[0].blocks).toBe(TARGET);
    expect(gaps[0].text).toBe(GAP_TEXT);
  });

  it('four captures of which one is isolated give a gap between the group of three and the single one', () => {
    const matches: PairMatch[] = [
      { a: 'cap-a', b: 'cap-b', verified: 40 },
      { a: 'cap-b', b: 'cap-c', verified: 40 },
    ];
    const table = linkTable(['cap-a', 'cap-b', 'cap-c', 'cap-d'], matches);
    const groups = components(table, 30);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.length === 3)?.slice().sort()).toEqual(['cap-a', 'cap-b', 'cap-c']);
    expect(groups.find((g) => g.length === 1)).toEqual(['cap-d']);

    const gaps = gapsFor(groups, TARGET);
    expect(gaps).toHaveLength(1);
    const [g1, g2] = gaps[0].between;
    expect([g1.slice().sort(), g2.slice().sort()]).toEqual([['cap-a', 'cap-b', 'cap-c'], ['cap-d']]);
    expect(gaps[0].blocks).toBe(TARGET);
    expect(gaps[0].text).toBe(GAP_TEXT);
  });

  it('a pair just under the bar does not join: 29 verified links at a minimum of 30 is a gap', () => {
    const table = linkTable(['cap-a', 'cap-b'], [{ a: 'cap-a', b: 'cap-b', verified: 29 }]);
    expect(components(table, 30)).toHaveLength(2);
  });
});
