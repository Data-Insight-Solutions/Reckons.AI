import { describe, expect, it } from 'vitest';
import type { Statement } from '../types';
import { storedDecisions, writtenOptions } from '../reckoning-written';
import { decisionNav } from '../reckoning-written';
import { reckoningStatements } from '../reckoning-entity';

// The proposal round trip (stored rows -> options with pictures) is exercised with real generated rows in
// the option-review generator test (scripts/__tests__); this file holds the edges that need no proposal.
describe('reading a stored proposal for display', () => {
  const none: Statement[] = [];
  it('finds nothing in an empty knowledge base', () => {
    expect(storedDecisions(none)).toEqual([]);
    expect(writtenOptions(none, 'missing', new Map())).toEqual([]);
  });
  it('does not list a Reckoning that has no proposal yet', () => {
    const rows = reckoningStatements('abc', [], 'A situation worth a reckoning', 1);
    expect(storedDecisions(rows)).toEqual([]);
    expect(writtenOptions(rows, 'abc', new Map())).toEqual([]);
  });
});

describe('decisionNav: moving between decisions in one tab (no tab per decision)', () => {
  const ds = [{ id: 'a', label: 'A', status: 'open' }, { id: 'b', label: 'B', status: 'done' }, { id: 'c', label: 'C', status: 'open' }, { id: 'd', label: 'D', status: 'open' }];
  const decided = (s: string) => s === 'done';
  it('says where the current decision sits, and its neighbours', () => {
    expect(decisionNav(ds, 'b', decided)).toMatchObject({ index: 1, total: 4, prev: 'a', next: 'c', nextUndecided: 'c', undecided: 3 });
    expect(decisionNav(ds, 'a', decided)).toMatchObject({ prev: null, next: 'b' });
  });
  it('next undecided skips settled ones and wraps around, never itself', () => {
    expect(decisionNav(ds, 'a', decided)?.nextUndecided).toBe('c');      // skips b (settled)
    expect(decisionNav(ds, 'd', decided)?.nextUndecided).toBe('a');      // wraps
    expect(decisionNav([{ id: 'x', label: 'X', status: 'open' }], 'x', decided)?.nextUndecided).toBeNull();
  });
  it('an unknown id gives no position', () => { expect(decisionNav(ds, 'zz', decided)).toBeNull(); });
});
