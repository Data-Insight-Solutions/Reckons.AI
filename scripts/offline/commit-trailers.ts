#!/usr/bin/env npx tsx
/**
 * COMMIT TRAILERS (F254 phase 1a, SCRIPT tier) — every agent commit names its model and intent.
 *
 * Matt, 2026-10-08: "we need to track editor model for every change. Auditable user intent is
 * also critical." An AGENT commit (a Co-Authored-By trailer naming a model, or a Model: trailer
 * already present) must carry BOTH non-empty trailers:
 *   Model: <id>[@<version>]
 *   Intent: <the person's request>
 * Merge commits and human commits are exempt. A violation exits non-zero.
 *
 * RANGE. `--base=<ref>` checks <ref>..HEAD. With no --base: origin/dev..HEAD when that range is
 * non-empty (a PR: the checkout is a merge commit, which is exempt, plus the PR's commits).
 * When it is empty (a push to dev itself, where HEAD == origin/dev) fall back to commits since
 * the cutoff instant 2026-10-09T12:00:00Z (a bare date was tried first and failed: UTC midnight
 * had already passed with agent commits on dev that predate this check), so old history is grandfathered and never fails. `--since=<date>`
 * overrides the cutoff.
 *
 * HONEST LIMIT: trailers are self-attested text. A model id here is a CLAIM the committing
 * agent made, not a verification, and a person can type any Intent. This catches forgetting,
 * not lying. Co-Authored-By detection is a name match, so an agent that omits that trailer
 * AND the Model trailer is invisible to this check.
 */
import { execFileSync } from 'node:child_process';

export const CUTOFF = '2026-10-09T12:00:00Z';

export type CommitInfo = {
  sha: string;
  subject: string;
  parents: number;
  /** Author date, ISO 8601. The AUTHOR date, because a rebase or cherry-pick resets the committer date. */
  authorDate?: string;
  /** Parsed trailers as [key, value] pairs (git interpret-trailers --parse). */
  trailers: [string, string][];
};

export type Violation = { sha: string; subject: string; missing: ('Model' | 'Intent')[] };

const MODEL_NAME = /claude|anthropic|gpt|openai|codex|gemini|llama|mistral|qwen|devstral|copilot|cursor|ollama|deepseek|grok|\bai\b|\bllm\b/i;

const get = (c: CommitInfo, key: string) =>
  c.trailers.filter(([k]) => k.toLowerCase() === key.toLowerCase()).map(([, v]) => v.trim());

export function isAgentCommit(c: CommitInfo): boolean {
  if (get(c, 'Model').length > 0) return true;
  return get(c, 'Co-Authored-By').some((v) => MODEL_NAME.test(v));
}

/** Pure core: which commits break the rule. */
export function checkCommits(commits: CommitInfo[]): Violation[] {
  const out: Violation[] = [];
  for (const c of commits) {
    if (c.parents > 1 || !isAgentCommit(c)) continue;
    const missing: Violation['missing'] = [];
    if (!get(c, 'Model').some((v) => v.length > 0)) missing.push('Model');
    if (!get(c, 'Intent').some((v) => v.length > 0)) missing.push('Intent');
    if (missing.length) out.push({ sha: c.sha, subject: c.subject, missing });
  }
  return out;
}

/**
 * GRANDFATHERING IN EVERY MODE, not only on a push to dev. Without it, merging this check made every
 * already-open PR fail, because their agent commits predate the rule (found 2026-10-09 in review: the
 * whole 0.2.6 queue would have gone red). Commits authored before the cutoff are not checked.
 * A commit with no known date is checked, so a missing date cannot excuse a commit.
 */
export function afterCutoff(commits: CommitInfo[], cutoff: string): CommitInfo[] {
  const t = Date.parse(cutoff);
  return commits.filter((c) => !c.authorDate || Date.parse(c.authorDate) >= t);
}

export function parseTrailers(text: string): [string, string][] {
  return text
    .split('\n')
    .map((l) => l.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2]] as [string, string]);
}

const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function readRange(rangeArgs: string[]): CommitInfo[] {
  const shas = git('rev-list', ...rangeArgs).split('\n').filter(Boolean);
  return shas.map((sha) => {
    const subject = git('log', '-1', '--format=%s', sha).trim();
    const authorDate = git('log', '-1', '--format=%aI', sha).trim();
    const parents = git('log', '-1', '--format=%P', sha).trim().split(/\s+/).filter(Boolean).length;
    const msg = git('log', '-1', '--format=%B', sha);
    const trailers = parseTrailers(execFileSync('git', ['interpret-trailers', '--parse'], { input: msg, encoding: 'utf8' }));
    return { sha, subject, parents, authorDate, trailers };
  });
}

function main() {
  const argv = process.argv.slice(2);
  const arg = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  const base = arg('base');
  let rangeArgs: string[];
  let how: string;
  if (base) {
    rangeArgs = [`${base}..HEAD`];
    how = `${base}..HEAD`;
  } else {
    let n = 0;
    try { n = Number(git('rev-list', '--count', 'origin/dev..HEAD').trim()); } catch { /* no origin/dev */ }
    if (n > 0) {
      rangeArgs = ['origin/dev..HEAD'];
      how = 'origin/dev..HEAD';
    } else {
      const since = arg('since') ?? CUTOFF;
      rangeArgs = ['HEAD', `--since=${since}`];
      how = `commits since ${since} (no commits ahead of origin/dev; older history grandfathered)`;
    }
  }
  const cutoff = arg('since') ?? CUTOFF;
  const inRange = readRange(rangeArgs);
  const commits = afterCutoff(inRange, cutoff);
  if (commits.length < inRange.length) how += `; ${inRange.length - commits.length} authored before ${cutoff} grandfathered`;
  const bad = checkCommits(commits);
  const agents = commits.filter((c) => c.parents <= 1 && isAgentCommit(c)).length;
  console.log(`commit-trailers: ${commits.length} commit(s) in ${how}; ${agents} agent commit(s)`);
  if (!bad.length) {
    console.log('commit-trailers: OK — every agent commit carries Model: and Intent:');
    return;
  }
  for (const v of bad) console.log(`  FAIL ${v.sha.slice(0, 7)} ${v.subject} — missing ${v.missing.map((m) => m + ':').join(' and ')}`);
  console.log(`commit-trailers: ${bad.length} violation(s). Amend with trailers 'Model: <id>[@<version>]' and 'Intent: <the request>'.`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
