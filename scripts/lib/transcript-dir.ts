/**
 * Where Claude Code writes this project's transcripts.
 *
 * The logs are keyed by the directory Claude Code ran in, mangled into a flat name. For a git
 * WORKTREE that is the worktree path — where no transcripts have ever been written — so a job
 * that derives the directory from `process.cwd()` alone reports "no transcripts" and exits
 * non-zero from any `git worktree add` checkout. That failure looks identical to a job that
 * failed because something is wrong, which is the silent-miss shape AGENTS.md documents for
 * code-review.ts's --worktree flag.
 *
 * Extracted after the same bug was found in three places (context-composition, session-tokens,
 * ab-graph-benchmark — the last one dodging it only by hardcoding one developer's home path).
 * The promotion ladder in AGENTS.md says the second occurrence is the signal to make it a rule.
 */
import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import path from 'path';

/** Claude Code's path-mangling convention for a working directory. */
export const projectDir = (cwd: string): string =>
  path.join(homedir(), '.claude', 'projects', cwd.replace(/[/.]/g, '-'));

/**
 * The transcript directory for the current checkout, falling back to the MAIN worktree when
 * run from a linked one. Returns the cwd-derived path unchanged when nothing better exists,
 * so callers keep their own "no transcripts here" message and exit code.
 */
export function resolveTranscriptDir(cwd: string = process.cwd()): string {
  const here = projectDir(cwd);
  if (existsSync(here)) return here;
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (common.endsWith('/.git')) {
      const main = projectDir(common.slice(0, -'/.git'.length));
      if (existsSync(main)) return main;
    }
  } catch {
    /* not a git checkout, or git unavailable — fall through */
  }
  return here;
}
