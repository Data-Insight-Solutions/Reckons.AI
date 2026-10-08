/**
 * The MAIN checkout's workspace, from any worktree.
 *
 * Offline jobs write proposals to reckons-workspace/knowledge.pending.jsonl, a git-ignored folder. Run
 * from a worktree, a relative path lands in THAT worktree's copy, which is invisible to the app's
 * review queue and deleted with the worktree. Found 2026-09-29: two local reviews run from worktrees
 * were read from the main queue instead, so stale entries were triaged as if they were the new
 * findings, and one review's real output was lost when its worktree was removed.
 *
 * git's common directory is shared by every worktree and sits in the main checkout, so its parent is
 * the main checkout's root. Outside git this falls back to the current directory.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export function mainCheckoutRoot(): string {
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return path.dirname(common);
  } catch {
    return process.cwd();
  }
}

/** The review queue the app actually drains, whichever checkout or worktree the job runs in. */
export function pendingQueuePath(): string {
  return path.join(mainCheckoutRoot(), 'reckons-workspace', 'knowledge.pending.jsonl');
}
