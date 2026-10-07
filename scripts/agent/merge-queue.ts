/**
 * The merge queue (F89 kb:autonomous-loop) — land a list of PRs on `dev`, in order, unattended.
 *
 * WHY THIS IS A SCRIPT. On 2026-09-30 a session spent most of an hour polling `gh pr checks`,
 * re-verifying base branches and merging by hand, and Matt asked why that was not offloaded. Every
 * step is checkable by a rule, so it belongs to the script tier: no model, no tokens, and it can
 * run while the orchestrator does something else. The orchestrator reads the log when it ends.
 *
 * Per PR, in the order given:
 *   1. REFUSE   unless the base is `dev`. Production deploys from `main` on every push, and
 *               `gh pr edit --base` can fail silently, so the base is re-read immediately before
 *               every merge rather than trusted from an earlier read.
 *   2. UPDATE   if the branch does not contain `dev`'s current head, merge `dev` into it
 *               (`gh pr update-branch`). Without branch protection GitHub does not report a PR
 *               as behind, so "green" could mean green on a stale base — the failure that hit
 *               six PRs on 2026-09-30 when an audit fix landed on `dev` after they ran.
 *   3. WAIT     for every check on the head commit to finish.
 *   4. MERGE    only when every check passed (or was skipped), pinned to the head commit that was
 *               checked, with the repository's "Merge PR #n: <title>" subject.
 * A failed check, a conflict, a refused base or a timeout STOPS the queue (or, with --keep-going,
 * skips that PR) and says which, by name. Nothing is retried blindly and nothing is forced.
 *
 * Usage:
 *   npx tsx scripts/agent/merge-queue.ts 333 326 327            land them, in that order
 *   npx tsx scripts/agent/merge-queue.ts 333 326 --dry-run      report what each would do
 *   npx tsx scripts/agent/merge-queue.ts … --keep-going --poll=60 --timeout-min=60
 *   npx tsx scripts/agent/merge-queue.ts … --sync-local=/path/to/checkout
 *
 * --sync-local: after each merge, fast-forward that checkout to the new dev, so the dev server
 * running from it (localhost) shows what was just merged. Matt, 2026-10-07: "localhost should
 * serve dev" — that day his localhost was 44 commits behind, because every merge happened on
 * GitHub and nothing brought it back. Only a clean checkout ON dev with no local-only commits is
 * moved; anything else is skipped with the reason. A lockfile change is REPORTED, never
 * installed: worktrees and running servers may share that node_modules.
 */
import { execFileSync } from 'node:child_process';

export type Check = { name: string; status: string; conclusion: string };

export type PrState = {
  number: number;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  checks: Check[];
  /** Whether the head contains the base branch's current head. */
  containsBase: boolean;
};

export type Action =
  | { kind: 'done'; why: string }
  | { kind: 'refuse'; why: string }
  | { kind: 'stop'; why: string }
  | { kind: 'update'; why: string }
  | { kind: 'wait'; why: string }
  | { kind: 'merge'; why: string };

export const MERGE_BASE = 'dev';

const PASSED = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);

/** Normalize one entry of `statusCheckRollup` (a CheckRun or a legacy StatusContext). */
export function toCheck(raw: Record<string, unknown>): Check {
  if (raw.__typename === 'StatusContext') {
    const state = String(raw.state ?? '');
    const pending = state === 'PENDING' || state === 'EXPECTED';
    return { name: String(raw.context ?? '?'), status: pending ? 'IN_PROGRESS' : 'COMPLETED', conclusion: pending ? '' : state };
  }
  return { name: String(raw.name ?? '?'), status: String(raw.status ?? ''), conclusion: String(raw.conclusion ?? '') };
}

/** What to do next with one PR. Pure, so every branch of it is tested. */
export function decide(pr: PrState): Action {
  if (pr.state === 'MERGED') return { kind: 'done', why: 'already merged' };
  if (pr.state === 'CLOSED') return { kind: 'stop', why: 'closed without merging' };
  if (pr.baseRefName !== MERGE_BASE) return { kind: 'refuse', why: `base is "${pr.baseRefName}", not "${MERGE_BASE}" — never merged from here` };
  if (pr.isDraft) return { kind: 'refuse', why: 'draft' };
  if (pr.mergeable === 'CONFLICTING') return { kind: 'stop', why: `conflicts with ${MERGE_BASE} — needs a person or the orchestrator` };
  if (!pr.containsBase) return { kind: 'update', why: `does not contain ${MERGE_BASE}'s head; CI on it would be CI on a stale base` };
  if (pr.mergeable === 'UNKNOWN') return { kind: 'wait', why: 'GitHub is still computing mergeability' };
  if (pr.checks.length === 0) return { kind: 'wait', why: 'no checks reported yet' };
  const running = pr.checks.filter((c) => c.status !== 'COMPLETED');
  const failed = pr.checks.filter((c) => c.status === 'COMPLETED' && !PASSED.has(c.conclusion));
  // A failure is final even while other checks run: waiting would only delay saying so.
  if (failed.length > 0) return { kind: 'stop', why: `failed: ${failed.map((c) => `${c.name} (${c.conclusion.toLowerCase()})`).join(', ')}` };
  if (running.length > 0) return { kind: 'wait', why: `${running.length} check(s) running: ${running.map((c) => c.name).join(', ')}` };
  return { kind: 'merge', why: `${pr.checks.length} check(s) passed` };
}

export type LocalCheckout = { branch: string; dirty: boolean; ahead: number; behind: number };
export type SyncAction = { kind: 'sync' | 'skip' | 'current'; why: string };

/** Whether to fast-forward a local checkout to the merged dev. Pure, so every branch is tested. */
export function decideSync(c: LocalCheckout): SyncAction {
  if (c.branch !== MERGE_BASE) return { kind: 'skip', why: `on "${c.branch || 'detached HEAD'}", not ${MERGE_BASE}` };
  if (c.dirty) return { kind: 'skip', why: 'uncommitted changes' };
  if (c.ahead > 0) return { kind: 'skip', why: `${c.ahead} local commit(s) not on origin/${MERGE_BASE}` };
  if (c.behind === 0) return { kind: 'current', why: `already at origin/${MERGE_BASE}` };
  return { kind: 'sync', why: `${c.behind} commit(s) behind` };
}

// ── IO ───────────────────────────────────────────────────────────────────────────────────────

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function readPr(n: number): PrState {
  const j = JSON.parse(sh('gh', ['pr', 'view', String(n), '--json',
    'number,title,state,isDraft,baseRefName,headRefName,headRefOid,mergeable,statusCheckRollup']));
  sh('git', ['fetch', '-q', 'origin', MERGE_BASE, j.headRefName]);
  const baseHead = sh('git', ['rev-parse', `origin/${MERGE_BASE}`]);
  let containsBase = false;
  try { sh('git', ['merge-base', '--is-ancestor', baseHead, j.headRefOid]); containsBase = true; } catch { /* not an ancestor */ }
  return {
    number: j.number, title: j.title, state: j.state, isDraft: j.isDraft,
    baseRefName: j.baseRefName, headRefName: j.headRefName, headRefOid: j.headRefOid,
    mergeable: j.mergeable, checks: (j.statusCheckRollup ?? []).map(toCheck), containsBase,
  };
}

function syncLocal(dir: string): string {
  const git = (...a: string[]) => sh('git', ['-C', dir, ...a]);
  git('fetch', '-q', 'origin', MERGE_BASE);
  const count = (range: string) => Number(git('rev-list', '--count', range));
  const action = decideSync({
    branch: git('branch', '--show-current'),
    dirty: git('status', '--porcelain') !== '',
    ahead: count(`origin/${MERGE_BASE}..HEAD`),
    behind: count(`HEAD..origin/${MERGE_BASE}`),
  });
  if (action.kind !== 'sync') return `local ${dir}: ${action.kind === 'skip' ? 'NOT synced' : 'current'} (${action.why})`;
  const before = git('rev-parse', 'HEAD');
  git('merge', '-q', '--ff-only', `origin/${MERGE_BASE}`);
  const lockChanged = git('diff', '--name-only', before, 'HEAD', '--', 'package-lock.json') !== '';
  return `local ${dir}: synced (${action.why})${lockChanged ? ' — package-lock.json changed: run npm install there' : ''}`;
}

const log = (n: number, msg: string) => console.log(`${new Date().toISOString().slice(11, 19)}  #${n}  ${msg}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function land(n: number, opts: { dryRun: boolean; pollMs: number; timeoutMs: number; syncLocal?: string }): Promise<'merged' | 'done' | 'failed'> {
  const deadline = Date.now() + opts.timeoutMs;
  let lastWhy = '';
  let updated = false;
  for (;;) {
    const pr = readPr(n);
    const action = decide(pr);
    if (action.why !== lastWhy) { log(n, `${action.kind.toUpperCase()}: ${action.why}`); lastWhy = action.why; }
    if (opts.dryRun && action.kind !== 'done') return action.kind === 'merge' ? 'merged' : 'failed';
    switch (action.kind) {
      case 'done': return 'done';
      case 'refuse':
      case 'stop': return 'failed';
      case 'update':
        // Once only: a second "behind" after updating means dev moved again; say so rather than chase it forever.
        if (updated) { log(n, `${MERGE_BASE} moved again after the update; stopping rather than chasing it`); return 'failed'; }
        sh('gh', ['pr', 'update-branch', String(n)]);
        updated = true;
        log(n, `merged ${MERGE_BASE} into ${pr.headRefName}; waiting for CI on the new head`);
        await sleep(15_000);
        continue;
      case 'wait':
        if (Date.now() > deadline) { log(n, `TIMEOUT after ${Math.round(opts.timeoutMs / 60_000)} min: ${action.why}`); return 'failed'; }
        await sleep(opts.pollMs);
        continue;
      case 'merge': {
        // Re-read the base at the last moment: it is the one fact that decides whether this deploys.
        const fresh = JSON.parse(sh('gh', ['pr', 'view', String(n), '--json', 'baseRefName,headRefOid']));
        if (fresh.baseRefName !== MERGE_BASE || fresh.headRefOid !== pr.headRefOid) {
          log(n, `base or head changed under us (${fresh.baseRefName} @ ${fresh.headRefOid.slice(0, 7)}); re-checking`);
          continue;
        }
        sh('gh', ['pr', 'merge', String(n), '--merge', '--match-head-commit', pr.headRefOid,
          '--subject', `Merge PR #${n}: ${pr.title}`]);
        log(n, `MERGED into ${MERGE_BASE} at ${pr.headRefOid.slice(0, 7)}`);
        if (opts.syncLocal) {
          try { log(n, syncLocal(opts.syncLocal)); } catch (e) { log(n, `local sync FAILED: ${(e as Error).message.split('\n')[0]}`); }
        }
        return 'merged';
      }
    }
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const prs = args.filter((a) => /^\d+$/.test(a)).map(Number);
  if (prs.length === 0) { console.error('usage: merge-queue.ts <pr> [<pr> …] [--dry-run] [--keep-going] [--poll=60] [--timeout-min=60] [--sync-local=<checkout>]'); process.exit(2); }
  const opts = {
    dryRun: args.includes('--dry-run'),
    pollMs: Number(flag('poll') ?? 60) * 1000,
    timeoutMs: Number(flag('timeout-min') ?? 60) * 60_000,
    syncLocal: flag('sync-local'),
  };
  const keepGoing = args.includes('--keep-going');
  const results: Array<[number, string]> = [];
  for (const n of prs) {
    let r: string;
    try { r = await land(n, opts); }
    catch (e) { log(n, `ERROR: ${(e as Error).message.split('\n')[0]}`); r = 'failed'; }
    results.push([n, opts.dryRun ? (r === 'merged' ? 'would merge' : r === 'done' ? 'done' : 'would not merge') : r]);
    if (r === 'failed' && !keepGoing && !opts.dryRun) { log(n, 'queue stopped (pass --keep-going to skip a failed PR instead)'); break; }
  }
  console.log('\nsummary: ' + results.map(([n, r]) => `#${n} ${r}`).join(' · '));
  const notReached = prs.slice(results.length);
  if (notReached.length) console.log(`not reached: ${notReached.map((n) => `#${n}`).join(' ')}`);
  process.exit(results.some(([, r]) => r === 'failed') ? 1 : 0);
}

if (process.argv[1] && process.argv[1].endsWith('merge-queue.ts')) void main();
