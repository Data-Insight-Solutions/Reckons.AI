import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureGitState, captureStateFingerprint, runSucceeded, selectReviewBatch, validateRunReport, validateStateFingerprint,
} from '../run-contract';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'runner-contract-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'runner@test.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Runner Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

describe('runner completion contract', () => {
  it('requires both command and independent verification to pass', () => {
    expect(runSucceeded(0, 0)).toBe(true);
    expect(runSucceeded(7, 0)).toBe(false);
    expect(runSucceeded(0, 1)).toBe(false);
    expect(runSucceeded(7, 1)).toBe(false);
  });
});

describe('bounded local-review batch selection', () => {
  const discovered = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'];

  it('starts at the first deterministic batch with no prior receipt', () => {
    expect(selectReviewBatch(discovered, 2).files).toEqual(['a.ts', 'b.ts']);
  });

  it('continues after the prior capped batch without a separate cursor file', () => {
    const first = selectReviewBatch(discovered, 2);
    const second = selectReviewBatch(discovered, 2, {
      discoverySha256: first.discoverySha256,
      files: first.files,
      omitted: 3,
    });
    const third = selectReviewBatch(discovered, 2, {
      discoverySha256: second.discoverySha256,
      files: second.files,
      omitted: 3,
    });
    expect(second).toMatchObject({ files: ['c.ts', 'd.ts'], start: 2 });
    expect(third).toMatchObject({ files: ['e.ts'], start: 4 });
  });

  it('resets safely when the discovered scope changes', () => {
    const old = selectReviewBatch(discovered, 2);
    const changed = selectReviewBatch([...discovered, 'new.ts'], 2, {
      discoverySha256: old.discoverySha256,
      files: old.files,
      omitted: 3,
    });
    expect(changed).toMatchObject({ files: ['a.ts', 'b.ts'], start: 0 });
  });
});

describe('git receipt fingerprint', () => {
  it('binds unstaged, staged, and untracked bytes without hashing an empty fallback', () => {
    const dir = repo();
    const clean = captureGitState(dir);
    expect(clean.available).toBe(true);
    if (!clean.available) return;

    // Larger than Node execSync's historic default buffer: only the digest returns to Node.
    writeFileSync(path.join(dir, 'tracked.txt'), 'x'.repeat(2 * 1024 * 1024));
    const unstaged = captureGitState(dir);
    expect(unstaged.available).toBe(true);
    if (!unstaged.available) return;
    expect(unstaged.worktreeStateSha256).not.toBe(clean.worktreeStateSha256);

    execFileSync('git', ['add', 'tracked.txt'], { cwd: dir });
    const staged = captureGitState(dir);
    expect(staged.available).toBe(true);
    if (!staged.available) return;
    expect(staged.worktreeStateSha256).not.toBe(unstaged.worktreeStateSha256);

    mkdirSync(path.join(dir, 'new'));
    writeFileSync(path.join(dir, 'new', 'untracked.txt'), 'first');
    const untracked = captureGitState(dir);
    expect(untracked.available).toBe(true);
    if (!untracked.available) return;
    expect(untracked.worktreeStateSha256).not.toBe(staged.worktreeStateSha256);

    writeFileSync(path.join(dir, 'new', 'untracked.txt'), 'second');
    const changedUntracked = captureGitState(dir);
    expect(changedUntracked.available).toBe(true);
    if (!changedUntracked.available) return;
    expect(changedUntracked.worktreeStateSha256).not.toBe(untracked.worktreeStateSha256);
  });

  it('reports unavailable git state instead of returning SHA-256(empty)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-no-git-'));
    dirs.push(dir);
    const state = captureGitState(dir);
    expect(state.available).toBe(false);
    expect('worktreeStateSha256' in state).toBe(false);
  });
});

describe('task-specific report validation', () => {
  it('rejects incomplete button and visual coverage', () => {
    expect(validateRunReport('button-crawl', {
      schema: 'reckons.button-crawl/v1', finishedAt: new Date().toISOString(),
      routes: ['/', '/kb'], crawled: ['/'], skipped: [{ route: '/kb' }], findings: [],
    })).toEqual(expect.arrayContaining([expect.stringContaining('skipped'), expect.stringContaining('/kb')]));
    expect(validateRunReport('visual-diff', {
      schema: 'reckons.visual-diff/v1', finishedAt: new Date().toISOString(),
      base: 'https://a', head: 'https://b', routes: ['/'], skipped: [{ route: '/' }],
    })).toEqual(expect.arrayContaining([expect.stringContaining('skipped')]));
  });

  it('rejects vacuous button and visual coverage', () => {
    expect(validateRunReport('button-crawl', {
      schema: 'reckons.button-crawl/v1', finishedAt: new Date().toISOString(),
      routes: [], crawled: [], skipped: [], findings: [],
    })).toContain('button crawl requested no routes');
    expect(validateRunReport('visual-diff', {
      schema: 'reckons.visual-diff/v1', finishedAt: new Date().toISOString(),
      base: 'https://a', head: 'https://b', routes: [], flagged: 0, skipped: [],
    })).toContain('visual diff requested no routes');
  });

  it('rejects partial local review and requires consumed MCP provenance when asked', () => {
    const partial = {
      schema: 'reckons.local-code-review/v1', finishedAt: new Date().toISOString(),
      files: ['a.ts', 'b.ts'], discovered: 2, selected: 2, omitted: 0,
      discoverySha256: 'c'.repeat(64), reviewed: 1, failed: 1, truncatedFiles: [],
    };
    expect(validateRunReport('local-code-review', partial)).toEqual(expect.arrayContaining([
      expect.stringContaining('failed review'),
    ]));
    expect(validateRunReport('local-code-review', {
      ...partial, reviewed: 2, failed: 0, finishedAt: new Date().toISOString(),
    }, { requireMcp: true })).toEqual(expect.arrayContaining([expect.stringContaining('MCP context')]));
  });

  it('rejects a fully reviewed selected batch when discovery exceeded the cap', () => {
    expect(validateRunReport('local-code-review', {
      schema: 'reckons.local-code-review/v1', finishedAt: new Date().toISOString(),
      files: ['a.ts', 'b.ts'], discovered: 5, selected: 2, omitted: 3,
      discoverySha256: 'c'.repeat(64), reviewed: 2, failed: 0, truncatedFiles: [],
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('3 discovered file(s) were omitted'),
    ]));
  });

  it('rejects inconsistent discovery, selection, and coverage accounting', () => {
    const errors = validateRunReport('local-code-review', {
      schema: 'reckons.local-code-review/v1', finishedAt: new Date().toISOString(),
      files: ['a.ts'], discovered: 4, selected: 2, omitted: 1,
      discoverySha256: 'c'.repeat(64), reviewed: 0, failed: 0, truncatedFiles: [],
    });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('selected count'),
      expect.stringContaining('discovery accounting'),
      expect.stringContaining('review coverage'),
    ]));
  });

  it('rejects a truncated diff even when every selected file was attempted', () => {
    expect(validateRunReport('local-code-review', {
      schema: 'reckons.local-code-review/v1', finishedAt: new Date().toISOString(),
      files: ['large.ts'], discovered: 1, selected: 1, omitted: 0,
      discoverySha256: 'c'.repeat(64), reviewed: 0, failed: 0, truncatedFiles: ['large.ts'],
    })).toEqual(expect.arrayContaining([expect.stringContaining('diff(s) were truncated')]));
  });

  it('accepts complete reports', () => {
    expect(validateRunReport('button-crawl', {
      schema: 'reckons.button-crawl/v1', finishedAt: new Date().toISOString(),
      routes: ['/', '/kb'], crawled: ['/', '/kb'], skipped: [], findings: [],
    })).toEqual([]);
    expect(validateRunReport('visual-diff', {
      schema: 'reckons.visual-diff/v1', finishedAt: new Date().toISOString(),
      base: 'https://a', head: 'https://b', routes: ['/'], flagged: 0, skipped: [],
    })).toEqual([]);
    expect(validateRunReport('local-code-review', {
      schema: 'reckons.local-code-review/v1', files: ['a.ts'],
      discovered: 1, selected: 1, omitted: 0, reviewed: 1, failed: 0,
      discoverySha256: 'c'.repeat(64), truncatedFiles: [],
      finishedAt: new Date().toISOString(),
      mcpContext: {
        query: 'F81', sourceContentSha256: 'a'.repeat(64), consumedContentSha256: 'b'.repeat(64),
        sourceChars: 10, consumedChars: 10, truncated: false,
      },
    }, { requireMcp: true })).toEqual([]);
  });
});

describe('state fingerprint without a repository', () => {
  const unavailable = () => ({ available: false as const, error: 'fatal: not a git repository' });
  const folder = () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'runner-plain-'));
    dirs.push(dir);
    return dir;
  };

  it('keeps the git fingerprint unchanged inside a repository', () => {
    const dir = repo();
    const fp = captureStateFingerprint({ cwd: dir, declaredPaths: ['tracked.txt'] });
    const state = captureGitState(dir);
    expect(fp.kind).toBe('git');
    if (fp.kind !== 'git' || !state.available) throw new Error('expected git');
    expect(fp.worktreeStateSha256).toBe(state.worktreeStateSha256);
    expect(validateStateFingerprint(fp)).toEqual([]);
  });

  it('uses an injected probe, not the machine', () => {
    const probe = () => ({
      available: true as const, head: 'h', dirty: false, statusSha256: 'a'.repeat(64),
      trackedDiffSha256: 'b'.repeat(64), untrackedFilesSha256: 'c'.repeat(64), worktreeStateSha256: 'd'.repeat(64),
    });
    expect(captureStateFingerprint({ cwd: folder(), gitProbe: probe }).kind).toBe('git');
  });

  it('fingerprints declared files and directories when git is unavailable', () => {
    const dir = folder();
    writeFileSync(path.join(dir, 'note.md'), 'one');
    mkdirSync(path.join(dir, 'kb/sub'), { recursive: true });
    writeFileSync(path.join(dir, 'kb/a.ttl'), 'a');
    writeFileSync(path.join(dir, 'kb/sub/b.ttl'), 'b');
    const opts = { cwd: dir, declaredPaths: ['note.md', 'kb', 'missing.txt'], gitProbe: unavailable };
    const fp = captureStateFingerprint(opts);
    if (fp.kind !== 'files') throw new Error(`expected files, got ${fp.kind}`);
    expect(fp.reason).toMatch(/not a git repository/);
    expect(fp.paths.find((p) => p.path === 'note.md')).toMatchObject({ exists: true, type: 'file', files: 1 });
    expect(fp.paths.find((p) => p.path === 'kb')).toMatchObject({ exists: true, type: 'directory', files: 2 });
    expect(fp.paths.find((p) => p.path === 'missing.txt')).toEqual({ path: 'missing.txt', exists: false });
    expect(validateStateFingerprint(fp)).toEqual([]);
    expect(captureStateFingerprint(opts)).toEqual(fp);
    writeFileSync(path.join(dir, 'kb/sub/b.ttl'), 'changed');
    const after = captureStateFingerprint(opts);
    if (after.kind !== 'files') throw new Error('expected files');
    expect(after.stateSha256).not.toBe(fp.stateSha256);
  });

  it('records kind none, with a reason, when there is no repository and no declared paths', () => {
    const fp = captureStateFingerprint({ cwd: folder(), declaredPaths: [], gitProbe: unavailable });
    expect(fp.kind).toBe('none');
    expect(fp).toMatchObject({ reason: expect.stringMatching(/declares no kpred:touches/) });
    expect(validateStateFingerprint(fp)).toEqual([]);
  });

  it('treats a throwing probe as unavailable', () => {
    const fp = captureStateFingerprint({ cwd: folder(), gitProbe: () => { throw new Error('boom'); } });
    expect(fp.kind).toBe('none');
  });

  it('rejects malformed fingerprints', () => {
    expect(validateStateFingerprint({ kind: 'bogus' })).not.toEqual([]);
    expect(validateStateFingerprint({ kind: 'none' })).not.toEqual([]);
    expect(validateStateFingerprint({ kind: 'files', paths: [] })).not.toEqual([]);
    expect(validateStateFingerprint(null)).not.toEqual([]);
  });
});
