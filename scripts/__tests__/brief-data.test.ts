import { describe, expect, it } from 'vitest';
import { formatFirstPullRequest } from '../lib/brief-data';

describe('formatFirstPullRequest', () => {
  it('reports no PR for the empty list instead of fabricating null fields', () => {
    expect(formatFirstPullRequest('[]')).toBe('');
  });

  it('formats the first open PR', () => {
    expect(formatFirstPullRequest(JSON.stringify([
      { number: 123, baseRefName: 'dev', title: 'Queue safety' },
    ]))).toBe('#123 → dev: Queue safety');
  });

  it('fails closed on invalid output from gh', () => {
    expect(formatFirstPullRequest('not json')).toBe('');
    expect(formatFirstPullRequest('[{"number":null}]')).toBe('');
  });
});
