import { execFileSync } from 'node:child_process';

const MAX_GIT_OUTPUT = 64 * 1024 * 1024;

function git(args: string[], cwd = process.cwd()): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function gitNul(args: string[], cwd = process.cwd()): string[] {
  const output = execFileSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: MAX_GIT_OUTPUT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return output.toString('utf8').split('\0').filter(Boolean);
}

/** Resolve a declared base exactly. An absent remote ref must not silently shrink to HEAD~1. */
export function resolveReviewBase(base: string, cwd = process.cwd()): string {
  const baseCommit = git(
    ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
    cwd,
  ).trim();
  const mergeBase = git(['merge-base', baseCommit, 'HEAD'], cwd).trim();
  if (!mergeBase) throw new Error(`git merge-base returned no commit for ${base} and HEAD`);
  return mergeBase;
}

export interface DiscoveredReviewFiles {
  files: string[];
  untracked: Set<string>;
}

/** Split a complete diff into bounded prompts without dropping bytes. Prefer line boundaries for
 * readable hunks, but split a single oversized binary/text line exactly at the limit. Joining the
 * returned chunks always recreates the input; a file is reviewed only after every chunk succeeds. */
export function chunkReviewDiff(diff: string, maxChars: number): string[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer');
  if (!diff) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < diff.length) {
    let end = Math.min(start + maxChars, diff.length);
    if (end < diff.length) {
      const newline = diff.lastIndexOf('\n', end - 1);
      if (newline >= start) end = newline + 1;
    }
    // No newline occurred in this window. Make progress through the oversized line.
    if (end <= start) end = Math.min(start + maxChars, diff.length);
    chunks.push(diff.slice(start, end));
    start = end;
  }
  return chunks;
}

/** Enumerate with NUL delimiters so whitespace/newlines in valid Git paths are preserved. */
export function discoverReviewFiles(
  diffRange: string,
  includeWorktree: boolean,
  cwd = process.cwd(),
): DiscoveredReviewFiles {
  const files = gitNul(['diff', '--name-only', '-z', diffRange, '--'], cwd);
  const untracked = includeWorktree
    ? new Set(gitNul(['ls-files', '--others', '--exclude-standard', '-z', '--'], cwd))
    : new Set<string>();
  if (includeWorktree) files.push(...untracked);
  return { files, untracked };
}

/** Render exactly what the model will review. Only Git-confirmed untracked paths become additions;
 * an explicit but unchanged tracked path correctly returns an empty diff. */
export function renderReviewDiff(
  diffRange: string,
  file: string,
  untracked: ReadonlySet<string>,
  cwd = process.cwd(),
): string {
  if (!untracked.has(file)) {
    return git(['diff', '--no-ext-diff', '--binary', diffRange, '--', file], cwd);
  }

  try {
    return git(['diff', '--no-index', '--no-ext-diff', '--binary', '--', '/dev/null', file], cwd);
  } catch (error: any) {
    // `git diff --no-index` defines 1 as "different", not an execution failure.
    if (error?.status === 1) {
      if (typeof error.stdout === 'string') return error.stdout;
      if (Buffer.isBuffer(error.stdout)) return error.stdout.toString('utf8');
    }
    throw error;
  }
}
