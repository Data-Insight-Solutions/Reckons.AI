#!/usr/bin/env npx tsx
/**
 * RENAME PR (F203.6, script tier) — the weekly rename job opens a pull request when a batch is safe.
 * Matt, 2026-10-07: terminology is a standing maintenance job, and a safe rename batch should
 * arrive as a PR he merges, not as a report someone has to act on.
 *
 *   1. a fresh worktree on origin/dev, with its own `npm ci` and `svelte-kit sync` (without the
 *      generated $lib config the rename tool refuses names it cannot verify; seen 2026-10-07);
 *   2. scripts/ type-checked for missing exports BEFORE the batch, as a baseline;
 *   3. rename-identifier.ts --batch=term over every src/lib directory;
 *   4. gates: npm run check, the unit suite (it catches vi.mock keys the rename cannot see),
 *      naming-conventions --check, term-usage --check, graph-lint, and scripts/ again — a NEW
 *      missing export there is an importer outside the program the tool loads (also seen
 *      2026-10-07: scripts/kb-to-graph-ttl.ts);
 *   5. all green: commit, push, open a PR to dev. Anything red: no PR, the worktree is kept and its
 *      path printed, and the failing gate is named.
 *
 * It never merges and never targets main. Usage:
 *   npx tsx scripts/agent/rename-pr.ts [--term=kb] [--dry-run] [--keep]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';

export const BASE = 'dev';

/** "total renamed: 42" → 42; null when the line is missing (the tool failed or changed format). */
export function parseRenamed(output: string): number | null {
  const m = output.match(/total renamed:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

export type Gate = { name: string; ok: boolean; detail?: string };
export type Outcome = { kind: 'nothing' | 'pr' | 'stop'; why: string };

/** Pure: what to do after the batch and its gates. */
export function decide(renamed: number | null, gates: Gate[]): Outcome {
  if (renamed === null) return { kind: 'stop', why: 'the rename tool did not report a total' };
  if (renamed === 0) return { kind: 'nothing', why: 'no name is safe to rename this week' };
  const red = gates.filter((g) => !g.ok);
  if (red.length) return { kind: 'stop', why: `gate(s) failed: ${red.map((g) => g.name).join(', ')}` };
  return { kind: 'pr', why: `${renamed} renamed, ${gates.length} gates green` };
}

/** An earlier rename PR for the same term still open means this week's batch would duplicate it. */
export function openRenamePr(prs: { number: number; headRefName: string }[], term: string): number | null {
  return prs.find((p) => p.headRefName.startsWith(`refactor/rename-${term}`))?.number ?? null;
}

/** Diagnostics meaning "this import names something the module no longer exports". */
const MISSING_EXPORT = new Set([2305, 2614, 2724]);

/** scripts/ is outside the app's tsconfig; check its imports of src/ with the app's options. */
export function missingExports(dir: string): Set<string> {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (e === 'node_modules' || e === '__tests__') continue;
      const st = lstatSync(p); // a symlink is never followed: a link loop would recurse forever
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) walk(p); else if (/\.ts$/.test(e)) files.push(p);
    }
  };
  walk(join(dir, 'scripts'));
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, noEmit: true, skipLibCheck: true, allowJs: false,
  });
  const out = new Set<string>();
  for (const d of ts.getPreEmitDiagnostics(program)) {
    if (!MISSING_EXPORT.has(d.code) || !d.file) continue;
    out.add(`${d.file.fileName.slice(dir.length + 1)}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }
  return out;
}

function sh(cwd: string, cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function main(): void {
  const argv = process.argv.slice(2);
  const term = argv.find((a) => a.startsWith('--term='))?.split('=')[1] ?? 'kb';
  const dry = argv.includes('--dry-run');
  const root = resolve(import.meta.dirname ?? '.', '../..');
  const date = new Date().toISOString().slice(0, 10);
  const branch = `refactor/rename-${term}-auto-${date}`;
  const wt = join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local/state'), 'reckons/worktrees', `rename-${term}-${date}`);
  const log = (s: string) => console.log(`rename-pr: ${s}`);

  execFileSync('git', ['-C', root, 'fetch', '-q', 'origin', BASE]);
  // Observed 2026-10-07: the dry run proposed the same 42 names as the still-open #367.
  const open = openRenamePr(JSON.parse(execFileSync('gh', ['pr', 'list', '--state', 'open', '--base', BASE, '--json', 'number,headRefName', '--limit', '100'], { cwd: root, encoding: 'utf8' })), term);
  if (open !== null) { log(`rename PR #${open} for "${term}" is still open; merge or close it first. Nothing done.`); return; }
  if (existsSync(wt)) { log(`worktree ${wt} already exists; inspect or remove it first. Nothing done.`); process.exit(1); }
  mkdirSync(join(wt, '..'), { recursive: true });
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', branch, wt, `origin/${BASE}`]);
  log(`worktree ${wt} on ${branch}`);
  const step = (name: string, cmd: string, args: string[]) => { const r = sh(wt, cmd, args); if (!r.ok) log(`${name} failed:\n${r.out.slice(-1500)}`); return r; };

  if (!step('npm ci', 'npm', ['ci', '--no-audit', '--no-fund']).ok) process.exit(1);
  if (!step('svelte-kit sync', 'npx', ['svelte-kit', 'sync']).ok) process.exit(1);
  const before = missingExports(wt);

  const dirs = readdirSync(join(wt, 'src/lib')).filter((d) => statSync(join(wt, 'src/lib', d)).isDirectory() && d !== '__tests__')
    .map((d) => `src/lib/${d}`).join(',');
  const batch = sh(wt, 'npx', ['tsx', 'scripts/offline/rename-identifier.ts', '--batch=term', `--term=${term}`, `--dir=${dirs}`, ...(dry ? ['--dry-run'] : [])]);
  const table = batch.out.split('\n').filter((l) => l.startsWith('|')).join('\n');
  const renamed = parseRenamed(batch.out.replace('total would-rename', 'total renamed'));
  log(`batch: ${renamed ?? '?'} ${dry ? 'would be ' : ''}renamed`);
  if (dry || !renamed) {
    const outcome = decide(renamed, []);
    log(dry ? `dry run: ${renamed ?? '?'} would be renamed; no gates run, nothing written` : outcome.why);
    if (!argv.includes('--keep')) { execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', wt]); execFileSync('git', ['-C', root, 'branch', '-D', branch]); }
    process.exit(outcome.kind === 'stop' ? 1 : 0);
  }

  const gates: Gate[] = [
    { name: 'npm run check', ...pick(step('check', 'npm', ['run', 'check'])) },
    { name: 'unit suite', ...pick(step('vitest', 'npx', ['vitest', 'run'])) },
    { name: 'naming ratchet', ...pick(step('naming', 'npx', ['tsx', 'scripts/offline/naming-conventions.ts', '--check'])) },
    { name: 'ambiguity ratchet', ...pick(step('term-usage', 'npx', ['tsx', 'scripts/offline/term-usage.ts', '--check'])) },
    { name: 'graph-lint', ...pick(step('graph-lint', 'npx', ['tsx', 'scripts/offline/graph-lint.ts'])) },
  ];
  const added = [...missingExports(wt)].filter((e) => !before.has(e));
  gates.push({ name: 'scripts/ imports', ok: added.length === 0, detail: added.join('\n') });
  if (added.length) log(`scripts/ now import names that no longer exist:\n${added.join('\n')}`);

  const outcome = decide(renamed, gates);
  log(outcome.why);
  if (outcome.kind !== 'pr') { log(`no PR. Worktree kept for inspection: ${wt}`); process.exit(1); }

  sh(wt, 'git', ['add', '-A', 'src', 'scripts']);
  const msg = `refactor(naming): automatic ${term} rename batch, ${renamed} names (F203.6)\n\nOpened by scripts/agent/rename-pr.ts. Gates: ${gates.map((g) => g.name).join(', ')}.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`;
  if (!step('commit', 'git', ['commit', '-q', '-m', msg]).ok) process.exit(1);
  if (!step('push', 'git', ['push', '-q', '-u', 'origin', branch]).ok) process.exit(1);
  const body = [
    `Weekly terminology job (F203.6, Matt 2026-10-07: a safe rename batch arrives as a PR). **${renamed}** top-level \`${term}\` names renamed by \`rename-identifier.ts --batch=term\`.`,
    '', table, '',
    `Gates run in a fresh worktree on \`origin/${BASE}\` after \`npm ci\` and \`svelte-kit sync\`: ${gates.map((g) => `${g.name} ✓`).join(' · ')}. E2E and pixel equality run in CI.`,
    '', 'Refused and ambiguous names are listed by the tool and left alone. Review the diff; merge is yours.',
    '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
  ].join('\n');
  const pr = step('gh pr create', 'gh', ['pr', 'create', '--base', BASE, '--head', branch, '--title', `refactor(naming): automatic ${term} rename batch, ${renamed} names (F203.6)`, '--body', body]);
  if (!pr.ok) process.exit(1);
  log(`PR: ${pr.out.trim().split('\n').pop()}`);
  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', wt]);
}

function pick(r: { ok: boolean; out: string }): { ok: boolean; detail?: string } {
  return r.ok ? { ok: true } : { ok: false, detail: r.out.slice(-800) };
}

if (process.argv[1] && process.argv[1].endsWith('rename-pr.ts')) main();
