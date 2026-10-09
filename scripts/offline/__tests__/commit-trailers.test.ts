import { describe, it, expect } from 'vitest';
import { checkCommits, parseTrailers, type CommitInfo } from '../commit-trailers.ts';

const c = (trailers: [string, string][], parents = 1): CommitInfo => ({ sha: 'abc1234def', subject: 's', parents, trailers });
const CO: [string, string] = ['Co-Authored-By', 'Claude Sonnet 5.5 <noreply@anthropic.com>'];

describe('checkCommits', () => {
  it('passes an agent commit with both trailers', () => {
    expect(checkCommits([c([['Model', 'claude-sonnet-5-5'], ['Intent', 'do x'], CO])])).toEqual([]);
  });
  it('passes a Model with @version', () => {
    expect(checkCommits([c([['Model', 'qwen3-coder@2026-09'], ['Intent', 'do x'], CO])])).toEqual([]);
  });
  it('fails a missing Model', () => {
    expect(checkCommits([c([['Intent', 'do x'], CO])])[0].missing).toEqual(['Model']);
  });
  it('fails a missing Intent', () => {
    expect(checkCommits([c([['Model', 'm'], CO])])[0].missing).toEqual(['Intent']);
  });
  it('fails empty trailer values', () => {
    expect(checkCommits([c([['Model', ' '], ['Intent', ''], CO])])[0].missing).toEqual(['Model', 'Intent']);
  });
  it('treats a Model trailer alone as an agent commit', () => {
    expect(checkCommits([c([['Model', 'm']])])[0].missing).toEqual(['Intent']);
  });
  it('passes a human commit', () => {
    expect(checkCommits([c([])])).toEqual([]);
    expect(checkCommits([c([['Co-Authored-By', 'Ada Lovelace <ada@example.com>']])])).toEqual([]);
  });
  it('passes a merge commit', () => {
    expect(checkCommits([c([CO], 2)])).toEqual([]);
  });
});

describe('parseTrailers', () => {
  it('splits key and value', () => {
    expect(parseTrailers('Model: a@b\nIntent: x: y\n')).toEqual([['Model', 'a@b'], ['Intent', 'x: y']]);
  });
});
