import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { afterCutoff, checkCommits, parseTrailers, squashTrailers, CUTOFF, type CommitInfo } from '../commit-trailers.ts';

const c = (trailers: [string, string][], parents = 1): CommitInfo => ({ sha: 'abc1234def', subject: 's', parents, trailers });
const CO: [string, string] = ['Co-Authored-By', 'Claude Sonnet 5.5 <noreply@anthropic.com>'];

describe('GitHub squash provenance', () => {
  const parse = (message: string) => parseTrailers(execFileSync('git', ['interpret-trailers', '--parse'], { input: message, encoding: 'utf8' }));
  const block = 'Model: test-model\nIntent: test request\nCo-Authored-By: Codex <codex@example.com>';
  const message = (sections: string[]) => `feat: synthetic change (#123)\n\n${sections.map((s, i) => `* change ${i}\n\n${s}`).join('\n\n')}\n\n---------\n\nCo-Authored-By: Codex <codex@example.com>\n`;

  it('recovers every original intent from a structured squash with complete blocks', () => {
    const got = squashTrailers(message([block, block.replace('test request', 'follow-up request')]), parse);
    expect(got?.filter(([key]) => key === 'Intent').map(([, value]) => value)).toEqual(['test request', 'follow-up request']);
    expect(checkCommits([c(got!)])).toEqual([]);
  });

  it.each([
    'Model: test-model\nCo-Authored-By: Codex <codex@example.com>',
    'Model: test-model\nIntent: \nCo-Authored-By: Codex <codex@example.com>',
    'Model: test-model\nIntent: test request\n\nCo-Authored-By: Codex <codex@example.com>',
    'An undocumented constituent change',
  ])('refuses the whole squash when one section lacks a complete block: %s', (bad) => {
    expect(squashTrailers(message([block, bad]), parse)).toBeNull();
  });

  it('does not treat provenance in ordinary body text as trailers', () => {
    expect(squashTrailers(`feat: ordinary\n\n${block}\n\nMore explanation\n\nCo-Authored-By: Codex <codex@example.com>`, parse)).toBeNull();
    expect(squashTrailers(message([block]).replace(' (#123)', ''), parse)).toBeNull();
    expect(squashTrailers(message([block]).replace('\n---------\n', '\n'), parse)).toBeNull();
  });

  it('refuses a squash naming a final model author absent from its original blocks', () => {
    const msg = message([block]).replace(/Co-Authored-By: Codex <codex@example.com>\n$/, 'Co-Authored-By: Claude <claude@example.com>\n');
    expect(squashTrailers(msg, parse)).toBeNull();
  });
});

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

describe('default CUTOFF (local sweep on dev itself)', () => {
  it('is the instant the check merged (#423), so older agent commits without trailers are never flagged', () => {
    // Observed 2026-10-13: a cutoff of 2026-10-09T12:00Z made every local sweep on dev fail on 27
    // commits that predate the rule, while CI (which checks only the PR range) passed.
    expect(CUTOFF).toBe('2026-10-13T17:56:06Z');
    const old = { sha: 'old', subject: 'feat(F248): before the rule', parents: 1, authorDate: '2026-10-10T08:00:00Z', trailers: [['Co-Authored-By', 'Claude Sonnet 5.5 <noreply@anthropic.com>']] as [string, string][] };
    expect(checkCommits(afterCutoff([old], CUTOFF))).toEqual([]);
  });
});

describe('afterCutoff', () => {
  const c = (sha: string, authorDate?: string) => ({ sha, subject: sha, parents: 1, authorDate, trailers: [] as [string, string][] });
  it('grandfathers commits authored before the cutoff in any mode, and checks the rest', () => {
    const kept = afterCutoff([c('old', '2026-10-08T23:00:00Z'), c('new', '2026-10-09T12:00:01Z'), c('edge', '2026-10-09T12:00:00Z')], '2026-10-09T12:00:00Z');
    expect(kept.map((k) => k.sha)).toEqual(['new', 'edge']);
  });
  it('checks a commit whose date is unknown, so a missing date cannot excuse it', () => {
    expect(afterCutoff([c('nodate')], '2026-10-09T12:00:00Z').map((k) => k.sha)).toEqual(['nodate']);
  });
});

describe('a trailer written outside the last paragraph', () => {
  it('is reported as hidden, not missing', () => {
    const body = 'subject\n\nWhy.\n\nModel: claude-opus-5-5\nIntent: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n';
    const commit: CommitInfo = { sha: 'abc1234', subject: 'subject', parents: 1, trailers: [['Co-Authored-By', 'Claude <noreply@anthropic.com>']], body };
    expect(checkCommits([commit])).toEqual([{ sha: 'abc1234', subject: 'subject', missing: ['Model', 'Intent'], hidden: true }]);
    expect(checkCommits([{ ...commit, body: 'subject\n\nCo-Authored-By: Claude\n' }])[0].hidden).toBeUndefined();
  });
});
