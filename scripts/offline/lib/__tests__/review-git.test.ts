import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chunkReviewDiff, discoverReviewFiles, renderReviewDiff, resolveReviewBase } from '../review-git';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'code-review-git-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'review@test.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: dir });
  writeFileSync(path.join(dir, 'unchanged.ts'), 'export const stable = true;\n');
  const newlinePath = 'tracked\nname.ts';
  writeFileSync(path.join(dir, newlinePath), 'export const value = 1;\n');
  execFileSync('git', ['add', '--', 'unchanged.ts', newlinePath], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
  return dir;
}

describe('code-review Git boundary', () => {
  it('chunks a large diff without truncating or duplicating bytes', () => {
    const diff = `header\n${'x'.repeat(23)}\nsecond line\nend`;
    const chunks = chunkReviewDiff(diff, 10);
    expect(chunks.join('')).toBe(diff);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
    expect(() => chunkReviewDiff(diff, 0)).toThrow(/positive integer/);
  });

  it('fails closed when the declared base does not exist', () => {
    const dir = repo();
    expect(() => resolveReviewBase('refs/heads/definitely-missing', dir)).toThrow();
  });

  it('preserves NUL-delimited tracked paths and includes untracked paths exactly', () => {
    const dir = repo();
    const newlinePath = 'tracked\nname.ts';
    writeFileSync(path.join(dir, newlinePath), 'export const value = 2;\n');
    writeFileSync(path.join(dir, 'untracked file.ts'), 'export const fresh = true;\n');

    const base = resolveReviewBase('HEAD', dir);
    const found = discoverReviewFiles(base, true, dir);
    expect(found.files).toEqual(expect.arrayContaining([newlinePath, 'untracked file.ts']));
    expect(found.untracked.has('untracked file.ts')).toBe(true);
  });

  it('renders only confirmed untracked files as additions', () => {
    const dir = repo();
    writeFileSync(path.join(dir, 'new.ts'), 'export const fresh = true;\n');
    const base = resolveReviewBase('HEAD', dir);
    const found = discoverReviewFiles(base, true, dir);

    expect(renderReviewDiff(base, 'new.ts', found.untracked, dir)).toContain('export const fresh = true');
    expect(renderReviewDiff(base, 'unchanged.ts', found.untracked, dir)).toBe('');
  });
});
