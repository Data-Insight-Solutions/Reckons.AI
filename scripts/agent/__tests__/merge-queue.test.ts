import { describe, expect, it } from 'vitest';
import { decide, decideSync, toCheck, type PrState } from '../merge-queue';

const pass = (name: string) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' });
const base: PrState = {
  number: 1, title: 't', state: 'OPEN', isDraft: false, baseRefName: 'dev', headRefName: 'feat/x',
  headRefOid: 'abc', mergeable: 'MERGEABLE', checks: [pass('unit'), pass('e2e')], containsBase: true,
};
const pr = (over: Partial<PrState>): PrState => ({ ...base, ...over });

describe('merge queue decide()', () => {
  it('merges only when every check passed on a branch that contains dev', () => {
    expect(decide(base).kind).toBe('merge');
    expect(decide(pr({ checks: [pass('unit'), { name: 'lint', status: 'COMPLETED', conclusion: 'SKIPPED' }] })).kind).toBe('merge');
  });

  it('never merges a PR whose base is not dev — main above all', () => {
    const a = decide(pr({ baseRefName: 'main' }));
    expect(a.kind).toBe('refuse');
    expect(a.why).toContain('"main"');
    expect(decide(pr({ baseRefName: 'staging' })).kind).toBe('refuse');
  });

  it('updates a branch that does not contain dev before trusting its checks', () => {
    // Green on a stale base is the 2026-09-30 failure: six PRs predated the audit fix.
    expect(decide(pr({ containsBase: false })).kind).toBe('update');
  });

  it('stops on a failed check and names it, even while others still run', () => {
    const a = decide(pr({ checks: [pass('unit'), { name: 'E2E', status: 'COMPLETED', conclusion: 'FAILURE' }, { name: 'Visual', status: 'IN_PROGRESS', conclusion: '' }] }));
    expect(a.kind).toBe('stop');
    expect(a.why).toContain('E2E (failure)');
  });

  it('treats cancelled and timed-out checks as failures, not passes', () => {
    expect(decide(pr({ checks: [{ name: 'e2e', status: 'COMPLETED', conclusion: 'CANCELLED' }] })).kind).toBe('stop');
    expect(decide(pr({ checks: [{ name: 'e2e', status: 'COMPLETED', conclusion: 'TIMED_OUT' }] })).kind).toBe('stop');
  });

  it('waits while checks run, while none are reported, and while mergeability is unknown', () => {
    expect(decide(pr({ checks: [pass('unit'), { name: 'E2E', status: 'QUEUED', conclusion: '' }] })).kind).toBe('wait');
    expect(decide(pr({ checks: [] })).kind).toBe('wait');
    expect(decide(pr({ mergeable: 'UNKNOWN' })).kind).toBe('wait');
  });

  it('stops on a conflict instead of updating into it', () => {
    expect(decide(pr({ mergeable: 'CONFLICTING', containsBase: false })).kind).toBe('stop');
  });

  it('refuses drafts, reports merged as done and closed as a stop', () => {
    expect(decide(pr({ isDraft: true })).kind).toBe('refuse');
    expect(decide(pr({ state: 'MERGED', baseRefName: 'main' })).kind).toBe('done');
    expect(decide(pr({ state: 'CLOSED' })).kind).toBe('stop');
  });
});

describe('toCheck()', () => {
  it('reads check runs and legacy status contexts alike', () => {
    expect(toCheck({ __typename: 'CheckRun', name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' })).toEqual(pass('unit'));
    expect(toCheck({ __typename: 'StatusContext', context: 'Cloudflare Pages', state: 'SUCCESS' })).toEqual(pass('Cloudflare Pages'));
    expect(toCheck({ __typename: 'StatusContext', context: 'ci', state: 'PENDING' }).status).toBe('IN_PROGRESS');
  });
});

describe('merge queue decideSync() — keeping localhost on dev', () => {
  const clean = { branch: 'dev', dirty: false, ahead: 0, behind: 3 };
  it('fast-forwards a clean checkout on dev that is behind', () => {
    expect(decideSync(clean)).toEqual({ kind: 'sync', why: '3 commit(s) behind' });
    expect(decideSync({ ...clean, behind: 0 }).kind).toBe('current');
  });
  it('never moves a checkout on another branch, with local edits, or with local-only commits', () => {
    expect(decideSync({ ...clean, branch: 'fix/x' })).toEqual({ kind: 'skip', why: 'on "fix/x", not dev' });
    expect(decideSync({ ...clean, branch: '' }).why).toContain('detached HEAD');
    expect(decideSync({ ...clean, dirty: true }).why).toBe('uncommitted changes');
    expect(decideSync({ ...clean, ahead: 2 }).why).toBe('2 local commit(s) not on origin/dev');
  });
});
