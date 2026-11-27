/**
 * F304.3 — the Claude commit figure for the showcase (script tier, zero tokens).
 *
 * Reads the git history at a named commit (default HEAD): the non-merge commits whose message
 * carries a Co-Authored-By trailer naming Claude, counted against all non-merge commits. The
 * result — the count, the total, the share to one decimal place, and the commit and date it was
 * measured at — is written into the marked block of the showcase starter file
 * (static/starter-matthew-roe.ttl), between the two marked lines.
 *
 * The figure is a measurement, not a claim: the walk's step 5 says exactly that — "The figure
 * here is measured from git." Re-measuring is cheap, so `--check` re-measures at the commit the
 * block records and exits 1 on any difference, which is how a hand-edited or stale block fails
 * loudly (the same shape as `scripts/starter/build-everyday.ts --check`).
 *
 * Usage:
 *   npx tsx scripts/showcase/claude-share.ts                 re-measure at HEAD, write the block
 *   npx tsx scripts/showcase/claude-share.ts --commit <ref>  re-measure at <ref> instead
 *   npx tsx scripts/showcase/claude-share.ts --check         exit 1 unless the block matches its recorded commit
 *   npx tsx scripts/showcase/claude-share.ts --file <path>   target a different starter file
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_FILE = path.join(ROOT, 'static', 'starter-matthew-roe.ttl');

/** The marked block's boundary lines — the contract between writer, reader and --check. */
export const BEGIN = '# BEGIN generated:claude-share';
export const END = '# END generated:claude-share';
export const BLOCK_RE = /# BEGIN generated:claude-share\n[\s\S]*?\n# END generated:claude-share/;
/** The entity the walk's step 5 lights up. Full URIs so the block never depends on the host file's prefixes. */
export const ENTITY = 'urn:kbase:concept/claude-commit-figure';

export interface CommitRecord { hash: string; date: string; message: string }
export interface Figure { claude: number; total: number; share: string; commit: string; date: string }

/** A Co-Authored-By trailer line whose value names Claude, anywhere in the message. */
export function namesClaude(message: string): boolean {
  return message.split('\n').some((line) => {
    const m = line.match(/^\s*Co-Authored-By:\s*(.+?)\s*$/);
    return m !== null && /claude/i.test(m[1]);
  });
}

/** The count, the total, and the share as a one-decimal percent. Zero commits read as 0.0%, not NaN. */
export function shareFromCommits(commits: CommitRecord[]): { claude: number; total: number; share: string } {
  const total = commits.length;
  const claude = commits.filter((c) => namesClaude(c.message)).length;
  const share = total === 0 ? '0.0%' : `${((claude * 100) / total).toFixed(1)}%`;
  return { claude, total, share };
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Non-merge commits reachable from `ref`, newest first. Merge commits never count, even with a trailer. */
export function nonMergeCommits(repo: string, ref: string): CommitRecord[] {
  const RS = '\x1e';
  const out = git(repo, ['log', '--no-merges', `--format=%H%x1f%aI%x1f%B${RS}`, ref, '--']);
  const records: CommitRecord[] = [];
  for (const chunk of out.split(RS)) {
    const body = chunk.replace(/^\n+/, '');
    if (!body) continue;
    const parts = body.split('\x1f');
    if (parts.length < 3 || !parts[0]) continue;
    records.push({ hash: parts[0], date: parts[1], message: parts.slice(2).join('\x1f') });
  }
  return records;
}

/** The commit `ref` resolves to: its hash and author date. */
export function refInfo(repo: string, ref: string): { hash: string; date: string } {
  const out = git(repo, ['log', '-1', '--format=%H%x1f%aI', ref, '--']).trim();
  const [hash, date] = out.split('\x1f');
  if (!hash || !date) throw new Error(`cannot resolve ${ref} in ${repo}`);
  return { hash, date };
}

/** The marked block: the entity and its five facts, between the two boundary lines. */
export function renderBlock(f: Figure): string {
  return [
    BEGIN,
    '# Measured from git history by scripts/showcase/claude-share.ts — do not edit between the marks.',
    `<${ENTITY}>`,
    `    <urn:kbase:predicate/claudeCommits> "${f.claude}" ;`,
    `    <urn:kbase:predicate/totalCommits> "${f.total}" ;`,
    `    <urn:kbase:predicate/claudeCommitShare> "${f.share}" ;`,
    `    <urn:kbase:predicate/measuredAtCommit> "${f.commit}" ;`,
    `    <urn:kbase:predicate/measuredAt> "${f.date}" .`,
    END,
  ].join('\n');
}

/** Read the figure back out of a starter file's marked block; null when the block is missing or incomplete. */
export function readFigure(ttl: string): Figure | null {
  const m = ttl.match(BLOCK_RE);
  if (!m) return null;
  const grab = (name: string): string | undefined => m[0].match(new RegExp(`urn:kbase:predicate/${name}(?:>)? "([^"]*)"`))?.[1];
  const claude = grab('claudeCommits');
  const total = grab('totalCommits');
  const share = grab('claudeCommitShare');
  const commit = grab('measuredAtCommit');
  const date = grab('measuredAt');
  if (claude === undefined || total === undefined || !share || !commit || !date) return null;
  const c = Number(claude);
  const t = Number(total);
  if (!Number.isInteger(c) || !Number.isInteger(t)) return null;
  return { claude: c, total: t, share, commit, date };
}

/** Insert the block (appending when the marks are absent) or replace the one already there. */
export function writeBlock(ttl: string, block: string): string {
  if (BLOCK_RE.test(ttl)) return ttl.replace(BLOCK_RE, block);
  const nl = ttl.endsWith('\n') ? '' : '\n';
  return ttl + nl + '\n' + block + '\n';
}

export function sameFigure(a: Figure, b: Figure): boolean {
  return a.claude === b.claude && a.total === b.total && a.share === b.share && a.commit === b.commit && a.date === b.date;
}

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const file = path.resolve(argValue(args, '--file') ?? DEFAULT_FILE);
  const check = args.includes('--check');

  if (!existsSync(file)) {
    console.error(`claude-share: no starter file at ${path.relative(ROOT, file)} — create it (F304.1) before measuring into it.`);
    process.exit(1);
  }
  const onDisk = readFileSync(file, 'utf8');
  const disk = readFigure(onDisk);

  let ref: string;
  if (args.includes('--commit')) ref = argValue(args, '--commit')!;
  else if (check) {
    if (!disk) {
      console.error(`claude-share --check: ${path.relative(ROOT, file)} carries no marked block. Run: npx tsx scripts/showcase/claude-share.ts`);
      process.exit(1);
    }
    // History is stable once a commit is recorded; the figure is what may have been touched by hand.
    ref = disk.commit;
  } else ref = 'HEAD';

  let computed: Figure;
  try {
    const info = refInfo(ROOT, ref);
    computed = { ...shareFromCommits(nonMergeCommits(ROOT, ref)), commit: info.hash, date: info.date.slice(0, 10) };
  } catch (e) {
    console.error(`claude-share: cannot measure at ${ref}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  if (check) {
    if (disk && sameFigure(disk, computed)) {
      console.log(`claude-share --check: up to date — ${computed.claude} of ${computed.total} non-merge commits carry a Claude trailer: ${computed.share}, measured at ${computed.commit.slice(0, 8)} (${computed.date})`);
      return;
    }
    const shown = disk ? `${disk.claude} of ${disk.total} = ${disk.share} at ${disk.commit.slice(0, 8)} (${disk.date})` : 'no marked block';
    console.error(
      `claude-share --check: stale or hand-edited — the block says ${shown}; git says ` +
      `${computed.claude} of ${computed.total} = ${computed.share} at ${computed.commit.slice(0, 8)} (${computed.date}). ` +
      'Run: npx tsx scripts/showcase/claude-share.ts',
    );
    process.exit(1);
  }

  writeFileSync(file, writeBlock(onDisk, renderBlock(computed)));
  console.log(
    `wrote the marked block into ${path.relative(ROOT, file)} — ${computed.claude} of ${computed.total} ` +
    `non-merge commits carry a Claude trailer: ${computed.share}, measured at ${computed.commit.slice(0, 8)} (${computed.date})`,
  );
}

if (process.argv[1] && /claude-share\.ts$/.test(process.argv[1])) main();
