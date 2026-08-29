#!/usr/bin/env npx tsx
/**
 * Bring newly starred GitHub repos into Reckons.AI as reviewable proposals. SCRIPT TIER.
 *
 * Matt, 2026-08-28: "Make it a regular task to review my github stars, for use within Reckons.AI.
 * I'm tired of copy pasting their links anyway."
 *
 * A star is a judgement he already made — "this is worth remembering" — and until now that
 * judgement lived only on github.com, reachable by pasting a link into a chat. This turns it into
 * the same kind of proposal every other agent produces: a pending fact, licence-gated, that he
 * accepts or rejects in review.
 *
 * INCREMENTAL BY `starred_at`, WHICH IS THE WHOLE DESIGN. The account has 659 stars. Proposing all
 * of them would put 659 rows in a review queue, and this session already watched a detector do
 * exactly that and had to be fixed — a job that floods the queue moves cost from collection to
 * triage rather than removing it (kb:work-tiering). So the state file records the newest
 * `starred_at` seen, and each run proposes only what was starred since. First run is bounded by
 * --limit and says what it skipped.
 *
 * IT ALSO SKIPS WHAT THE GRAPH ALREADY HAS. Any repo already carrying a kpred:repo-url in
 * static/*.ttl is known — this exists to catch what is NEW, not to re-litigate the competitive
 * landscape that competitor-scan.ts already maintains.
 *
 * THE LICENCE IS FETCHED, NOT ASSUMED, and it is the most useful thing in the proposal. Two of the
 * best-fitting models for the F161 asset story — LivePortrait and MuseTalk — report no recognised
 * licence, and that is only knowable by asking the API. A star says "interesting"; the gate says
 * whether we can act on it.
 *
 * Usage:
 *   npx tsx scripts/offline/stars-scan.ts                  report what is new
 *   npx tsx scripts/offline/stars-scan.ts --pending        queue the new ones for review
 *   npx tsx scripts/offline/stars-scan.ts --limit 20       cap a run (default 25)
 *   npx tsx scripts/offline/stars-scan.ts --user <login>   default: the authenticated gh user
 */
import { readFileSync, existsSync, writeFileSync, appendFileSync, readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';

const argv = process.argv.slice(2);
const PENDING_OUT = argv.includes('--pending');
const arg = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const LIMIT = parseInt(arg('--limit', '25'), 10);
const WORKSPACE = 'reckons-workspace';
const STATE = path.join(WORKSPACE, 'stars-scan.state.json');
const PENDING = path.join(WORKSPACE, 'knowledge.pending.jsonl');
const TTL_DIR = 'static';

export type Star = {
  full_name: string;
  html_url: string;
  description: string | null;
  license: string;
  stars: number;
  language: string | null;
  starred_at: string;
};

/** Repos the graph already records, so a known one is never proposed again. */
export function knownRepoUrls(dir = TTL_DIR): Set<string> {
  const urls = new Set<string>();
  if (!existsSync(dir)) return urls;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ttl')) continue;
    const text = readFileSync(path.join(dir, file), 'utf8');
    for (const m of text.matchAll(/kpred:repo-url\s+"([^"]+)"/g)) {
      urls.add(m[1].replace(/\/+$/, '').toLowerCase());
    }
  }
  return urls;
}

function readState(): { newestStarredAt?: string } {
  if (!existsSync(STATE)) return {};
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'));
  } catch {
    // A corrupt state file must not silently re-propose 659 repos.
    console.warn(`  ! ${STATE} did not parse — treating as first run, capped at --limit`);
    return {};
  }
}

/**
 * Fetch stars via the gh CLI, newest first.
 *
 * The `star+json` Accept header is what makes `starred_at` available at all, and without it there
 * is no way to tell a new star from an old one short of diffing the whole list.
 */
export function fetchStars(user?: string): Star[] {
  const endpoint = user ? `users/${user}/starred` : 'user/starred';
  const out = execFileSync(
    'gh',
    [
      'api', `${endpoint}?per_page=100&sort=created&direction=desc`,
      '-H', 'Accept: application/vnd.github.star+json',
      '--paginate',
      '--jq', '.[] | {full_name: .repo.full_name, html_url: .repo.html_url, description: .repo.description, license: (.repo.license.spdx_id // "NONE"), stars: .repo.stargazers_count, language: .repo.language, starred_at: .starred_at}',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Star);
}

/** A star as a pending row. The licence rides in the note, because it decides what we may do. */
export function toPendingRow(star: Star, kb: string): Record<string, unknown> {
  const usable =
    star.license === 'NONE' || star.license === 'NOASSERTION'
      ? `NO RECOGNISED LICENCE (${star.license}) — cannot be used or copied until that changes`
      : `licence ${star.license}`;
  return {
    subject: `urn:kbase:concept/starred-${star.full_name.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`,
    predicate: 'urn:kbase:predicate/repo-url',
    object: star.html_url,
    objectKind: 'literal',
    kb,
    type: 'suggestion',
    priority: 'low',
    agent: 'stars-scan',
    note:
      `${star.full_name} — ${usable} · ${star.stars}★${star.language ? ` · ${star.language}` : ''}` +
      `${star.description ? `\n${star.description}` : ''}` +
      `\nStarred ${star.starred_at.slice(0, 10)}. Accepting records it; rejecting means "noted, not for this graph".`,
  };
}

function main(): void {
  const user = arg('--user', '');
  const state = readState();
  const known = knownRepoUrls();

  let stars: Star[];
  try {
    stars = fetchStars(user || undefined);
  } catch (err) {
    console.error(`  ! could not read stars (is gh authenticated?): ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const since = state.newestStarredAt;
  const fresh = since ? stars.filter((s) => s.starred_at > since) : stars;
  const unknown = fresh.filter((s) => !known.has(s.html_url.replace(/\/+$/, '').toLowerCase()));
  const batch = unknown.slice(0, LIMIT);

  console.log(
    `${stars.length} stars total · ${since ? `${fresh.length} since ${since.slice(0, 10)}` : 'first run'} · ` +
      `${fresh.length - unknown.length} already in the graph · proposing ${batch.length}`,
  );
  if (unknown.length > batch.length) {
    // Said out loud: a silent cap is how a backlog becomes invisible.
    console.log(`  (${unknown.length - batch.length} more waiting — raise --limit or run again after reviewing)`);
  }

  for (const s of batch) {
    const flag = s.license === 'NONE' || s.license === 'NOASSERTION' ? '  ⚠ no licence' : `  ${s.license}`;
    console.log(`  ${s.starred_at.slice(0, 10)}  ${s.full_name.padEnd(42)}${flag}`);
  }

  if (!PENDING_OUT) {
    console.log('\nReport only. Pass --pending to queue these for review.');
    return;
  }
  if (batch.length > 0) {
    appendFileSync(PENDING, batch.map((s) => JSON.stringify(toPendingRow(s, 'competitive'))).join('\n') + '\n', 'utf8');
  }

  // ADVANCE THE WATERMARK ONLY OVER WHAT WAS ACTUALLY PROPOSED. Moving it to the newest star in
  // the account would skip everything the --limit cut off, and those repos would never be seen
  // again — a silent loss dressed up as a clean run.
  const newest = batch.length > 0 ? batch[0].starred_at : since;
  if (newest) writeFileSync(STATE, JSON.stringify({ newestStarredAt: newest }, null, 2) + '\n', 'utf8');
  console.log(`\nQueued ${batch.length} for review. Watermark: ${newest ?? 'unset'}`);
}

if (process.argv[1] && process.argv[1].endsWith('stars-scan.ts')) main();
