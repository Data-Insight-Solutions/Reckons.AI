/**
 * Git CLI wrappers for the Reckons.AI MCP server.
 *
 * Auto-detects repo root via `git rev-parse --show-toplevel`.
 * All functions return descriptive errors if `git` is unavailable.
 *
 * SECURITY (F107.1): every git invocation uses `execFileSync('git', args[])` with an
 * argument VECTOR — never a shell string. There is no shell, so metacharacters in a ref
 * (`;`, `|`, `$()`, backticks, newlines) are passed to git as literal argument text and
 * cannot execute. Tool arguments reach here from LLM-controlled MCP calls, so they are
 * treated as untrusted input. `sanitizeRef` is defense-in-depth against the one thing an
 * argument vector does NOT stop — a ref that looks like a git OPTION (`--output=…`,
 * `--upload-pack=…`) — by rejecting refs that begin with `-` or contain characters no
 * legitimate revision uses.
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

/**
 * Characters that appear in legitimate git revisions/ranges: names, paths, tags, hashes,
 * `HEAD~1`, `HEAD^2`, `origin/dev`, `A..B`, `A...B`, `@{upstream}`, `HEAD@{2}`. Anything
 * outside this set (whitespace, quotes, shell metacharacters, `:` for pathspecs) is refused.
 */
const REF_ALLOWED = /^[A-Za-z0-9._/~^@{}-]+$/;

/**
 * Validate an untrusted git revision/range argument. Throws on anything that is not a
 * plausible ref, rather than passing it to git — a bad ref is a caller error, and failing
 * loudly is safer than silently diffing the wrong thing.
 */
export function sanitizeRef(ref: string): string {
  if (typeof ref !== 'string' || ref.length === 0) {
    throw new Error('git ref must be a non-empty string');
  }
  if (ref.length > 256) {
    throw new Error('git ref is implausibly long');
  }
  // A leading '-' would let a ref masquerade as a git option even through an argument vector.
  if (ref.startsWith('-')) {
    throw new Error(`invalid git ref (looks like an option): ${ref}`);
  }
  if (!REF_ALLOWED.test(ref)) {
    throw new Error(`invalid git ref (disallowed characters): ${ref}`);
  }
  return ref;
}

/** Run `git` with an argument vector — no shell, so no metacharacter can execute. */
function run(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 10_000 }).trim();
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
  // Coerce defensively: `count` can arrive from an MCP tool argument. NaN → default of 5.
  const parsed = Math.floor(Number(count));
  const n = Math.min(Math.max(Number.isFinite(parsed) ? parsed : 5, 1), 20);

  // Use a rare separator to avoid issues with newlines/spaces in messages.
  const sep = '---GIT-SEP---';
  const format = `%H${sep}%h${sep}%an${sep}%aI${sep}%s`;
  const raw = run(['log', `-${n}`, `--pretty=format:${format}`], root);

  if (!raw) return [];

  return raw.split('\n').map(line => {
    const parts = line.split(sep);
    const hash = parts[0] ?? '';

    // Get files changed count. `hash` is git's own %H output (40 hex chars), but validate
    // it as hex anyway before it becomes a command argument — trust nothing untested.
    let filesChanged = 0;
    if (/^[0-9a-f]{7,40}$/.test(hash)) {
      try {
        const stat = run(['diff-tree', '--no-commit-id', '--name-only', '-r', hash], root);
        filesChanged = stat ? stat.split('\n').filter(Boolean).length : 0;
      } catch { /* skip */ }
    }

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
  const from = sanitizeRef(fromRef);
  const to = sanitizeRef(toRef);
  // `--` terminates option parsing so neither ref can be read as an option even if it
  // somehow slipped past sanitizeRef; the refs are also already validated above.
  const raw = run(['diff', '--name-status', from, to, '--'], root);

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
