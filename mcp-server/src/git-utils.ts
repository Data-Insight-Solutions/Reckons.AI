/**
 * Git CLI wrappers for the Reckons.AI MCP server.
 *
 * Auto-detects repo root via `git rev-parse --show-toplevel`.
 * All functions return descriptive errors if `git` is unavailable.
 */

import { execSync } from 'node:child_process';

export type GitStatus = {
  branch: string;
  ahead: number;
  behind: number;
  staged: string[];
  modified: string[];
  untracked: string[];
  clean: boolean;
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  message: string;
  filesChanged: number;
};

export type ChangedFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
};

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
}

function repoRoot(cwd?: string): string {
  return run('git rev-parse --show-toplevel', cwd);
}

export function gitStatus(cwd?: string): GitStatus {
  const root = repoRoot(cwd);

  const branch = run('git rev-parse --abbrev-ref HEAD', root);

  // Ahead/behind tracking branch
  let ahead = 0, behind = 0;
  try {
    const ab = run('git rev-list --left-right --count HEAD...@{upstream}', root);
    const [a, b] = ab.split(/\s+/);
    ahead = parseInt(a, 10) || 0;
    behind = parseInt(b, 10) || 0;
  } catch { /* no upstream or detached */ }

  // Porcelain status
  const porcelain = run('git status --porcelain', root);
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];

  for (const line of porcelain.split('\n')) {
    if (!line) continue;
    const idx = line[0];
    const wt = line[1];
    const file = line.slice(3);

    if (idx === '?') {
      untracked.push(file);
    } else {
      if (idx !== ' ' && idx !== '?') staged.push(file);
      if (wt !== ' ' && wt !== '?') modified.push(file);
    }
  }

  return {
    branch,
    ahead,
    behind,
    staged,
    modified,
    untracked,
    clean: staged.length === 0 && modified.length === 0 && untracked.length === 0,
  };
}

export function gitLog(count = 5, cwd?: string): GitCommit[] {
  const root = repoRoot(cwd);
  const n = Math.min(Math.max(count, 1), 20);

  // Use NUL-delimited format to avoid issues with newlines in messages
  const sep = '---GIT-SEP---';
  const format = `%H${sep}%h${sep}%an${sep}%aI${sep}%s`;
  const raw = run(`git log -${n} --pretty=format:"${format}"`, root);

  if (!raw) return [];

  return raw.split('\n').map(line => {
    const parts = line.split(sep);
    const hash = parts[0] ?? '';

    // Get files changed count
    let filesChanged = 0;
    try {
      const stat = run(`git diff-tree --no-commit-id --name-only -r ${hash}`, root);
      filesChanged = stat ? stat.split('\n').filter(Boolean).length : 0;
    } catch { /* skip */ }

    return {
      hash,
      shortHash: parts[1] ?? '',
      author: parts[2] ?? '',
      date: parts[3] ?? '',
      message: parts[4] ?? '',
      filesChanged,
    };
  });
}

export function gitChangedFiles(fromRef: string, toRef = 'HEAD', cwd?: string): ChangedFile[] {
  const root = repoRoot(cwd);
  const raw = run(`git diff --name-status ${fromRef} ${toRef}`, root);

  if (!raw) return [];

  return raw.split('\n').filter(Boolean).map(line => {
    const parts = line.split('\t');
    const statusChar = (parts[0] ?? '')[0];
    const path = parts[1] ?? parts[0]?.slice(1)?.trim() ?? '';

    const statusMap: Record<string, ChangedFile['status']> = {
      A: 'added',
      M: 'modified',
      D: 'deleted',
      R: 'renamed',
    };

    return {
      path: statusChar === 'R' ? (parts[2] ?? path) : path,
      status: statusMap[statusChar] ?? 'modified',
    };
  });
}
