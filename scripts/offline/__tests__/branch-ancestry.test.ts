import { describe, expect, it } from 'vitest';
import { carriedFromMain, isDeliberateBackMerge } from '../branch-ancestry.ts';

describe('branch-ancestry', () => {
  it('reports the head commits that exist only on main, in head order', () => {
    // A branch started from main: its own commit plus two of main's.
    expect(carriedFromMain(['own1', 'mainMerge', 'attest'], ['attest', 'mainMerge', 'other'])).toEqual(['mainMerge', 'attest']);
  });

  it('passes a branch built on its base, whatever main holds', () => {
    expect(carriedFromMain(['own1', 'own2'], ['attest', 'mainMerge'])).toEqual([]);
    expect(carriedFromMain([], ['attest'])).toEqual([]);
  });

  it('allows a back-merge only from a branch named for it', () => {
    expect(isDeliberateBackMerge('main')).toBe(true);
    expect(isDeliberateBackMerge('sync/main-attestations')).toBe(true);
    expect(isDeliberateBackMerge('feat/currents-client-wired')).toBe(false);
    expect(isDeliberateBackMerge('worktree-agent-abc')).toBe(false);
    expect(isDeliberateBackMerge(undefined)).toBe(false);
  });
});
