#!/usr/bin/env npx tsx
/**
 * PRIVATE TERMS CHECK — F286.3 (script tier, zero tokens, right by construction).
 *
 * Before a branch merges into the local integration repository, scan what would become public:
 * the ADDED lines of its diff, its commit messages, and its branch name, against a list of private
 * terms kept OUTSIDE every repository, in the person's config folder:
 *
 *   $XDG_CONFIG_HOME/reckons/private-terms.txt   (default ~/.config/reckons/private-terms.txt)
 *
 * One term per line, case-insensitive; blank lines and lines starting with # are ignored.
 *
 * It prints COUNTS AND POSITIONS, never a term and never the matching line, because the output of a
 * check can itself end up in a log, a commit or a PR. A file path that itself contains a term is
 * printed as "file #n (name withheld)".
 *
 * Exit codes: 0 clean, 1 at least one match, 2 NOT CONFIGURED (no list, unreadable, or empty).
 * Unknown is not a pass: a check that cannot run must not read as green.
 *
 * WEAKNESS, said out loud: this is a literal, case-insensitive substring match. It does not catch
 * a misspelling, a paraphrase, an image, or a term split across lines. It proves the listed terms
 * are absent, not that nothing private is present, and it is only as good as the list.
 *
 * Usage: npx tsx scripts/offline/private-terms-check.ts <base> <head> [--repo=<dir>]
 *        (head may be a branch name; it is scanned as the branch name too)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Hit = { where: 'branch' | 'commit' | 'diff'; position: string; count: number };
export type ScanResult = { hits: Hit[]; total: number; commits: number; files: number };

export function termsFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.length ? env.XDG_CONFIG_HOME : path.join(os.homedir(), '.config');
  return path.join(base, 'reckons', 'private-terms.txt');
}

/** The terms, or null when no usable list is configured. Pure apart from the read. */
export function loadTerms(file: string): string[] | null {
  if (!existsSync(file)) return null;
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const terms = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((l) => l.toLowerCase());
  return terms.length ? [...new Set(terms)] : null;
}

/** Number of listed terms occurring in `text` (each occurrence counts). */
export function countMatches(text: string, terms: string[]): number {
  const hay = text.toLowerCase();
  let n = 0;
  for (const t of terms) {
    let i = hay.indexOf(t);
    while (i >= 0) { n++; i = hay.indexOf(t, i + t.length); }
  }
  return n;
}

const git = (repo: string, args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function scanRange(repo: string, base: string, head: string, terms: string[]): ScanResult {
  const hits: Hit[] = [];
  const add = (where: Hit['where'], position: string, count: number) => { if (count > 0) hits.push({ where, position, count }); };

  add('branch', 'branch name', countMatches(head, terms));

  const log = git(repo, ['log', '--format=%x01%H%x02%B', `${base}..${head}`]).split('\x01').filter(Boolean);
  for (const entry of log) {
    const [sha, body = ''] = entry.split('\x02');
    body.split('\n').forEach((line, i) => add('commit', `commit ${sha.slice(0, 8)} message line ${i + 1}`, countMatches(line, terms)));
  }

  const diff = git(repo, ['diff', '--unified=0', '--no-color', '--no-ext-diff', `${base}...${head}`]).split('\n');
  let fileNo = 0;
  let label = '';
  let nextLine = 0;
  const files = new Set<number>();
  for (const line of diff) {
    if (line.startsWith('diff --git ')) { fileNo++; files.add(fileNo); label = `file #${fileNo}`; nextLine = 0; continue; }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).replace(/^b\//, '');
      const inPath = countMatches(p, terms);
      label = inPath ? `file #${fileNo} (name withheld)` : p;
      add('diff', `${label} (path)`, inPath);
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)/.exec(line);
    if (hunk) { nextLine = Number(hunk[1]); continue; }
    if (line.startsWith('+') && !line.startsWith('+++')) { add('diff', `${label}:${nextLine}`, countMatches(line.slice(1), terms)); nextLine++; }
  }
  return { hits, total: hits.reduce((s, h) => s + h.count, 0), commits: log.length, files: files.size };
}

export function formatResult(r: ScanResult): string[] {
  const out = [`private-terms-check: scanned ${r.commits} commit(s), ${r.files} file(s)`];
  if (!r.total) return [...out, 'private-terms-check: 0 matches'];
  const by = (w: Hit['where']) => r.hits.filter((h) => h.where === w).reduce((s, h) => s + h.count, 0);
  out.push(`private-terms-check: ${r.total} match(es): branch name ${by('branch')}, commit messages ${by('commit')}, diff ${by('diff')}`);
  for (const h of r.hits.slice(0, 50)) out.push(`  ${h.position}: ${h.count}`);
  if (r.hits.length > 50) out.push(`  ... and ${r.hits.length - 50} more position(s)`);
  return out;
}

function main(): void {
  const args = process.argv.slice(2);
  const pos = args.filter((a) => !a.startsWith('--'));
  const repo = args.find((a) => a.startsWith('--repo='))?.slice(7) ?? process.cwd();
  if (pos.length !== 2) { console.error('Usage: private-terms-check.ts <base> <head> [--repo=<dir>]'); process.exit(2); }
  const terms = loadTerms(termsFilePath());
  if (!terms) {
    console.error('private-terms-check: not configured (no private-terms.txt in the reckons config folder, or it is empty). Unknown is not a pass.');
    process.exit(2);
  }
  let result: ScanResult;
  try { result = scanRange(repo, pos[0], pos[1], terms); }
  catch (e) { console.error(`private-terms-check: could not read the range (${(e as Error).message.split('\n')[0].slice(0, 120)})`); process.exit(2); }
  const lines = formatResult(result);
  (result.total ? console.error : console.log)(lines.join('\n'));
  process.exit(result.total ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
