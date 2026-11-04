/**
 * BRANCH ANCESTRY — a PR into dev (or staging) must not carry commits that exist only on main.
 *
 * Found 2026-10-09 reviewing four agent PRs: an isolated worktree starts from the DEFAULT branch,
 * which is main, so three branches meant for dev carried main's promotion merges and a 2026-09-24
 * safety attestation that lives only on main. Merged, they would have pulled main's history into
 * dev; the first attempted fix (deleting the attestation in the branch) would, once promoted, have
 * deleted a real record from main. Neither shows up as a conflict or a failing test. This check
 * makes it a failed build instead of something a reviewer has to notice.
 *
 * RULE. For a PR whose base is B (not main): no commit may be reachable from both HEAD and
 * origin/main without also being reachable from origin/B. A promotion INTO main is exempt, since
 * that is what main-only history is for. A deliberate back-merge of main into dev is allowed only
 * from a head branch named `main` or `sync/main-*`, so it is a visible choice, never an accident.
 *
 * Base: --base=<branch>, else GITHUB_BASE_REF (set on pull_request runs). With neither (a push, or
 * a local run on dev) there is no PR to judge and the check passes, saying so.
 */
import { execFileSync } from 'node:child_process';

export type Commit = { sha: string; subject: string };

/** Pure: commits the head carries that are on main but not on the base. */
export function carriedFromMain(headOnly: readonly string[], mainOnly: readonly string[]): string[] {
  const main = new Set(mainOnly);
  return headOnly.filter((sha) => main.has(sha));
}

/** Pure: is this head branch a deliberate back-merge of main? */
export function isDeliberateBackMerge(headRef: string | undefined): boolean {
  return headRef === 'main' || /^sync\/main-/.test(headRef ?? '');
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hasRef = (ref: string) => { try { git('rev-parse', '--verify', '--quiet', ref); return true; } catch { return false; } };
const list = (...args: string[]) => git('rev-list', ...args).split('\n').filter(Boolean);

function main() {
  const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const base = arg('base') ?? process.env.GITHUB_BASE_REF ?? '';
  const headRef = arg('head') ?? process.env.GITHUB_HEAD_REF;
  if (!base) { console.log('branch-ancestry: not a pull request (no --base, no GITHUB_BASE_REF), nothing to check.'); return; }
  if (base === 'main') { console.log('branch-ancestry: PR into main, which is where main-only history belongs; nothing to check.'); return; }
  if (isDeliberateBackMerge(headRef)) { console.log(`branch-ancestry: ${headRef} -> ${base} is a deliberate back-merge of main; allowed.`); return; }

  for (const ref of ['origin/main', `origin/${base}`]) {
    if (!hasRef(ref)) { try { git('fetch', '--quiet', 'origin', ref.replace('origin/', '')); } catch { /* reported below */ } }
    if (!hasRef(ref)) {
      // Fail closed: a check that cannot see main must not report that nothing came from main.
      console.log(`branch-ancestry: FAIL — cannot resolve ${ref}, so this check cannot run. Fetch with history (fetch-depth: 0).`);
      process.exit(1);
    }
  }
  const carried = carriedFromMain(list('HEAD', `^origin/${base}`), list('origin/main', `^origin/${base}`));
  if (carried.length === 0) { console.log(`branch-ancestry: OK — nothing in HEAD..origin/${base} comes from main.`); return; }

  console.log(`branch-ancestry: FAIL — this PR into ${base} carries ${carried.length} commit(s) that exist only on main:`);
  for (const sha of carried.slice(0, 12)) console.log(`  ${sha.slice(0, 7)} ${git('log', '-1', '--format=%s', sha)}`);
  if (carried.length > 12) console.log(`  … and ${carried.length - 12} more`);
  console.log(`The branch was probably started from main. Rebuild it on ${base}: \`git checkout -B <branch> origin/${base}\`, then`
    + ' cherry-pick only your own commits. Do NOT delete what those commits added: that deletion would reach main on the next promotion.');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
