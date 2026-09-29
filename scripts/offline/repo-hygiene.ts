/**
 * REPO HYGIENE — what is tracked that should not be, and what is getting heavy.
 *
 * The repository is PUBLIC and takes real traffic (5.53k unique visitors in the 30 days to
 * 2026-09-22), so its tidiness is part of what people judge. The existing sweeps cover claims and
 * generated content — claim-audit for README/SAFETY/COUNSEL-BRIEF, docs-staleness for pages whose
 * facts moved, docs-edits for hand edits on generated pages, dead-weight for orphaned features.
 * None of them looks at the FILE TREE, which is how a 4.5 MB test artifact and a .ttl.bak ended
 * up tracked and shipping.
 *
 * Three rules, all decided by a fact rather than a judgment, which is why this is script tier:
 *
 *   tracked-but-ignored  `git ls-files -i -c` — files tracked AND matching .gitignore. Git will
 *                        not stop you: an ignore pattern added after a file was committed does
 *                        nothing, so the rule that was written to prevent a class of file keeps
 *                        failing silently on the ones already in.
 *   backup-artifact      .bak/.orig/.rej/.tmp/.swp/~/.DS_Store — never intentional, and one of
 *                        them (static/reckons-roadmap.ttl.bak) was being SERVED from static/.
 *   heavy-file           tracked files over a threshold, so growth is visible while it is still
 *                        one file rather than a history nobody can rewrite.
 *
 * NOT A DELETER. It reports; a human decides. Some heavy files are legitimate (a GLB model, a
 * visual baseline screenshot) and no rule can tell those from an accident — which is exactly the
 * line AGENTS.md draws between the script tier and everything above it.
 */
import { execFileSync } from 'child_process';
import { statSync } from 'fs';

const KB = (bytes: number) => Math.round(bytes / 1024);
const MB = (bytes: number) => (bytes / 1048576).toFixed(1);

const args = process.argv.slice(2);
const flag = (n: string, d: number) => Number(args.find((a) => a.startsWith(`--${n}=`))?.split('=')[1] ?? d);
/** Above this, a tracked file is worth a human glance. Not a limit — a threshold for attention. */
const HEAVY_KB = flag('heavy-kb', 1024);
const JSON_OUT = args.includes('--json');

const git = (a: string[]) =>
  execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);

type Finding = { check: string; path: string; detail: string };
const findings: Finding[] = [];

// ── tracked-but-ignored ──────────────────────────────────────────────────────
// A .gitignore entry added after the fact does NOT untrack what is already in.
for (const path of git(['ls-files', '-i', '-c', '--exclude-standard'])) {
  let size = '';
  try { size = ` (${MB(statSync(path).size)} MB)`; } catch { /* deleted in worktree */ }
  findings.push({
    check: 'tracked-but-ignored',
    path,
    detail: `matches a .gitignore pattern and is tracked anyway${size} — the ignore rule does ` +
            `nothing for it. Either \`git rm --cached\` it or say in .gitignore why it stays.`
  });
}

// ── backup-artifact ──────────────────────────────────────────────────────────
const BACKUP = /(\.(bak|orig|rej|tmp|swp|old)$|~$|(^|\/)\.DS_Store$)/i;
for (const path of git(['ls-files'])) {
  if (!BACKUP.test(path)) continue;
  if (findings.some((f) => f.path === path)) continue; // already reported above
  findings.push({
    check: 'backup-artifact',
    path,
    detail: `a backup or editor artifact, tracked${path.startsWith('static/') ? ' AND SERVED from static/' : ''}. ` +
            `These are never authored deliberately.`
  });
}

// ── heavy-file ───────────────────────────────────────────────────────────────
const heavy: Array<{ path: string; kb: number }> = [];
for (const path of git(['ls-files'])) {
  try {
    const kb = KB(statSync(path).size);
    if (kb >= HEAVY_KB) heavy.push({ path, kb });
  } catch { /* not in the worktree */ }
}
heavy.sort((a, b) => b.kb - a.kb);
for (const h of heavy) {
  if (findings.some((f) => f.path === h.path)) continue;
  findings.push({
    check: 'heavy-file',
    path: h.path,
    detail: `${(h.kb / 1024).toFixed(1)} MB tracked. Legitimate for a model or a visual baseline; ` +
            `an accident for anything generated. Worth a glance, not automatically wrong.`
  });
}

// ── report ───────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ findings, heavyThresholdKb: HEAVY_KB }, null, 2));
  process.exit(0);
}

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yel = (s: string) => `\x1b[33m${s}\x1b[0m`;
const grn = (s: string) => `\x1b[32m${s}\x1b[0m`;

console.log(`\n${bold('Repo hygiene')} ${dim(`— ${git(['ls-files']).length} tracked files, heavy at ${HEAVY_KB} KB`)}\n`);

const BLOCKING = new Set(['tracked-but-ignored', 'backup-artifact']);
let errors = 0;
for (const check of ['tracked-but-ignored', 'backup-artifact', 'heavy-file']) {
  const group = findings.filter((f) => f.check === check);
  if (group.length === 0) continue;
  const blocking = BLOCKING.has(check);
  if (blocking) errors += group.length;
  console.log(`${blocking ? red(bold(check)) : yel(bold(check))} (${group.length})`);
  for (const f of group) console.log(`  ${f.path}\n    ${dim(f.detail)}`);
  console.log();
}

if (findings.length === 0) console.log(grn('Clean — nothing tracked that should not be.\n'));
console.log(`${errors ? red(`${errors} error(s)`) : grn('0 error(s)')}, ${findings.length - errors} warning(s).`);
process.exit(errors > 0 ? 1 : 0);
