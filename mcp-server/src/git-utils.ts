/**
 * Git CLI wrappers for the Reckons.AI MCP server.
 *
 * Auto-detects repo root via `git rev-parse --show-toplevel`.
 * All functions return descriptive errors if `git` is unavailable.
 *
 * SECURITY (F107.1): commands run via execFileSync with an ARGUMENT ARRAY and no
 * shell, so a tool-supplied value (an LLM-controlled ref) cannot inject shell
 * metacharacters, command substitutions, or newlines - each arg is passed to git
 * verbatim. User-facing refs are additionally validated so they cannot masquerade
 * as git OPTIONS (a leading '-'), which execFile alone does not prevent.
 */

import { execFileSync } from 'node:child_process';

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

/** Run `git <args...>` with NO shell - args are passed to git verbatim. */
function run(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

/**
 * Validate a caller/tool-supplied git ref. execFile already removes shell-injection,
 * but a ref beginning with '-' could still be parsed by git as an option (e.g.
 * `--output=/etc/passwd`), and whitespace/control characters never appear in a real
 * ref. Reject both rather than pass them to git.
 */
function assertSafeRef(ref: string): string {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > 256) {
    throw new Error('git ref must be a non-empty string under 256 characters');
  }
  if (ref.startsWith('-')) {
    throw new Error(`git ref may not start with '-' (option injection): ${ref.slice(0, 40)}`);
  }
  // Reject whitespace and control characters (space, tab, newline, DEL, and below)
  // via char codes - they never appear in a legitimate ref, and this avoids regex
  // escapes that tooling has been observed to corrupt.
  for (let i = 0; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code <= 32 || code === 127) {
      throw new Error('git ref may not contain whitespace or control characters');
    }
  }
  return ref;
}

function repoRoot(cwd?: string): string {
  return run(['rev-parse', '--show-toplevel'], cwd);
}

export function gitStatus(cwd?: string): GitStatus {
  const root = repoRoot(cwd);

  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD'], root);

  // Ahead/behind tracking branch
  let ahead = 0, behind = 0;
  try {
    const ab = run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root);
    const [a, b] = ab.split(/\s+/);
    ahead = parseInt(a, 10) || 0;
    behind = parseInt(b, 10) || 0;
  } catch { /* no upstream or detached */ }

  // Porcelain status
  const porcelain = run(['status', '--porcelain'], root);
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

  // Use a rare separator to avoid issues with special characters in messages.
  const sep = '---GIT-SEP---';
  const format = `%H${sep}%h${sep}%an${sep}%aI${sep}%s`;
  // As an argument array value, the format needs no surrounding shell quotes.
  const raw = run(['log', `-${n}`, `--pretty=format:${format}`], root);

  if (!raw) return [];

  return raw.split('\n').map(line => {
    const parts = line.split(sep);
    const hash = parts[0] ?? '';

    // Files changed count. `hash` comes from git's own %H output, and is passed as a
    // single argument regardless, so it cannot alter the command.
    let filesChanged = 0;
    try {
      const stat = run(['diff-tree', '--no-commit-id', '--name-only', '-r', hash], root);
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
  // fromRef/toRef are the tool-controlled inputs - validate before use.
  const raw = run(['diff', '--name-status', assertSafeRef(fromRef), assertSafeRef(toRef)], root);

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
