import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BEGIN,
  END,
  ENTITY,
  namesClaude,
  nonMergeCommits,
  readFigure,
  refInfo,
  renderBlock,
  sameFigure,
  shareFromCommits,
  writeBlock,
  type CommitRecord,
  type Figure,
} from '../claude-share';

/**
 * F304.3 — the figure is a measurement, and its two properties are exactly testable:
 *   - a known repository gives an exact share (the done-test), with merges counted out even when
 *     a merge commit carries a Claude trailer;
 *   - --check's comparison is the block read back against what git says at the recorded commit,
 *     so a hand-edited block is caught.
 * The fixture is a tiny git repository in a temp dir — synthetic history, no personal content.
 */

let repo: string;
const git = (args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe' });
let files = 0;
const commit = (message: string) => {
  files += 1;
  const name = `fact-${files}.txt`;
  writeFileSync(join(repo, name), name + '\n');
  git(['add', name]);
  git(['commit', '-q', '-m', message]);
};

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'claude-share-fixture-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'commit.gpgsign', 'false']);
  commit('feat: first fact\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  commit('fix: a human-only commit');
  commit('chore: third fact\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  git(['checkout', '-q', '-b', 'side']);
  commit('feat: side fact\n\nCo-Authored-By: Claude <noreply@anthropic.com>');
  git(['checkout', '-q', 'main']);
  // The merge carries a Claude trailer on purpose: it must still be excluded by --no-merges.
  git(['merge', '-q', '--no-ff', 'side', '-m', 'merge: side in\n\nCo-Authored-By: Claude <noreply@anthropic.com>']);
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe('namesClaude', () => {
  it('counts a Co-Authored-By trailer naming Claude, wherever it sits in the message', () => {
    expect(namesClaude('feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>')).toBe(true);
    expect(namesClaude('Co-Authored-By:claude')).toBe(true);
  });
  it('does not count a trailer naming anyone else, or a body that merely mentions Claude', () => {
    expect(namesClaude('feat: x\n\nCo-Authored-By: Someone Else <other@example.invalid>')).toBe(false);
    expect(namesClaude('Built with Claude Code, but the trailer is the rule.')).toBe(false);
    expect(namesClaude('feat: x')).toBe(false);
  });
});

describe('shareFromCommits', () => {
  const rec = (n: number, claude: boolean): CommitRecord =>
    ({ hash: `h${n}`, date: '2026-01-01T00:00:00Z', message: claude ? 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>' : 'x' });
  it('gives the count, the total and the share to one decimal place', () => {
    expect(shareFromCommits([rec(1, true), rec(2, false), rec(3, true), rec(4, true)])).toEqual({ claude: 3, total: 4, share: '75.0%' });
    expect(shareFromCommits([rec(1, true), rec(2, true), rec(3, true)]).share).toBe('100.0%');
    expect(shareFromCommits([rec(1, false), rec(2, false), rec(3, false), rec(4, false), rec(5, true)]).share).toBe('20.0%');
  });
  it('reads an empty history as 0.0%, not NaN', () => {
    expect(shareFromCommits([])).toEqual({ claude: 0, total: 0, share: '0.0%' });
  });
});

describe('a fixture repository with known trailers', () => {
  it('counts 3 of 4 non-merge commits as Claude trailer commits: 75.0%', () => {
    const commits = nonMergeCommits(repo, 'HEAD');
    const merge = git(['rev-parse', 'HEAD']);
    expect(commits, 'the merge commit is excluded even though it carries a Claude trailer').toHaveLength(4);
    expect(commits.some((c) => c.hash === merge.trim())).toBe(false);
    expect(shareFromCommits(commits)).toEqual({ claude: 3, total: 4, share: '75.0%' });
  });

  it('resolves the recorded ref to its hash and author date', () => {
    const head = git(['rev-parse', 'HEAD']).trim();
    const info = refInfo(repo, 'HEAD');
    expect(info.hash).toBe(head);
    expect(info.date).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('parses multi-line messages out of the log format', () => {
    const commits = nonMergeCommits(repo, 'HEAD');
    expect(commits.every((c) => c.hash.length === 40)).toBe(true);
    expect(commits.filter((c) => namesClaude(c.message))).toHaveLength(3);
    expect(commits[0].message.split('\n').length).toBeGreaterThan(1);
  });
});

const FIGURE: Figure = { claude: 3, total: 4, share: '75.0%', commit: 'a'.repeat(40), date: '2026-11-24' };

describe('the marked block', () => {
  it('round-trips: render, then read back the same figure', () => {
    const block = renderBlock(FIGURE);
    expect(block.split('\n')[0]).toBe(BEGIN);
    expect(block.split('\n').at(-1)).toBe(END);
    expect(block).toContain(ENTITY);
    const back = readFigure(block);
    expect(back).not.toBeNull();
    expect(sameFigure(back as Figure, FIGURE)).toBe(true);
  });

  it('is plain Turtle in a minimal host file (n3 parses it)', async () => {
    const { Parser } = await import('n3');
    const host = '@prefix kb: <urn:kbase:concept/> .\n@prefix kpred: <urn:kbase:predicate/> .\n\nkb:example\n    kpred:example "one" .\n\n' + renderBlock(FIGURE);
    const quads = new Parser({ format: 'text/turtle' }).parse(host);
    expect(quads.filter((q) => String((q.subject as { value: string }).value).includes('claude-commit-figure'))).toHaveLength(5);
  });

  it('inserts when the marks are absent and replaces the one already there', () => {
    const host = '@prefix kb: <urn:kbase:concept/> .\nkb:example\n    <urn:kbase:predicate/example> "one" .\n';
    const once = writeBlock(host, renderBlock(FIGURE));
    expect(once.match(new RegExp(BEGIN.replace(/#/g, '\\#')))).not.toBeNull();
    const twice = writeBlock(once, renderBlock({ ...FIGURE, share: '80.0%' }));
    expect(twice.match(new RegExp(BEGIN.replace(/#/g, '\\#'))) ?? []).toHaveLength(1);
    expect(readFigure(twice)?.share).toBe('80.0%');
    expect(readFigure(twice)?.claude).toBe(3);
  });

  it('reads null from a file with no marked block', () => {
    expect(readFigure('@prefix kb: <urn:kbase:concept/> .\nkb:example "one" .\n')).toBeNull();
  });

  it('catches a hand-edited share the way --check does', () => {
    const onDisk = writeBlock('kb:example "one" .\n', renderBlock(FIGURE));
    const tampered = onDisk.replace('75.0%', '10.0%');
    const disk = readFigure(tampered);
    expect(disk).not.toBeNull();
    expect(sameFigure(disk as Figure, FIGURE), 'the edited block must not pass the check').toBe(false);
  });
});
