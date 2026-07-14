#!/usr/bin/env npx tsx
/**
 * Offline job runner — one list, one command.
 *
 * Runs every enabled job in scripts/offline/jobs.json, in order, in one go. Add,
 * remove, or toggle jobs by editing that file (no code change). Jobs are offline
 * diagnostics, so a job that exits non-zero (e.g. branch-align finding drift)
 * does NOT stop the run — every job runs, and a summary prints at the end.
 * Findings are queued to reckons-workspace/knowledge.pending.jsonl for review.
 *
 * Usage:
 *   npm run offline:all                    run all enabled jobs (script tier first)
 *   npm run offline:all -- --tier=script   only the free, deterministic jobs (no Ollama)
 *   npm run offline:all -- --only=a,b      run only these (even if disabled)
 *   npm run offline:all -- --list          list jobs without running
 *   npm run offline:all -- --ci            exit non-zero if a job marked "blocking" failed
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import path from 'path';

/** F74.3 work tiering: `script` = deterministic, no LLM, zero tokens. `agent` = a local
 *  model filling a judgment hole inside a scripted harness; proposals only. */
type Tier = 'script' | 'agent';

interface Job {
  name: string;
  cmd: string;
  desc?: string;
  enabled?: boolean;
  tier?: Tier;
  /** Under --ci, a failure here fails the build. Everything else stays advisory. */
  blocking?: boolean;
}

const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith('--only='))?.split('=')[1]?.split(',');
const tier = argv.find((a) => a.startsWith('--tier='))?.split('=')[1] as Tier | undefined;
const LIST = argv.includes('--list');
const CI = argv.includes('--ci');

const jobsFile = path.resolve('scripts/offline/jobs.json');
const all: Job[] = JSON.parse(readFileSync(jobsFile, 'utf8')).jobs;
// Script tier first: it is free and catches the deterministic problems before a local
// model spends time forming an opinion about them.
const rank = (j: Job) => ((j.tier ?? 'agent') === 'script' ? 0 : 1);
const jobs = [...all].sort((a, b) => rank(a) - rank(b));

const B = '\x1b[1m';
const D = '\x1b[2m';
const Y = '\x1b[33m';
const G = '\x1b[32m';
const R = '\x1b[31m';
const X = '\x1b[0m';

if (LIST) {
  console.log(`Offline jobs (${jobsFile}):\n`);
  for (const j of jobs) {
    const on = j.enabled ?? true;
    const t = (j.tier ?? 'agent') === 'script' ? `${G}[script]${X}` : `${Y}[agent]${X}`;
    console.log(`  ${on ? G + '●' + X : D + '○' + X} ${t} ${B}${j.name}${X}${on ? '' : D + ' (disabled)' + X}`);
    if (j.desc) console.log(`      ${D}${j.desc}${X}`);
    console.log(`      ${D}$ ${j.cmd}${X}`);
  }
  process.exit(0);
}

const selected = jobs
  .filter((j) => (only ? only.includes(j.name) : j.enabled ?? true))
  .filter((j) => (tier ? (j.tier ?? 'agent') === tier : true));
if (selected.length === 0) {
  console.log('No jobs selected. Edit scripts/offline/jobs.json (set "enabled": true) or pass --only=<name>.');
  process.exit(0);
}

console.log(`${B}Offline jobs${X} — running ${selected.length} of ${jobs.length}\n`);
const results: { name: string; ok: boolean; ms: number; blocking: boolean }[] = [];
for (const job of selected) {
  console.log(`\n${B}▶ ${job.name}${X}${job.desc ? ` ${D}— ${job.desc}${X}` : ''}`);
  console.log(`  ${D}$ ${job.cmd}${X}\n`);
  const t = Date.now();
  const blocking = job.blocking ?? false;
  try {
    execSync(job.cmd, { stdio: 'inherit', shell: '/bin/bash' });
    results.push({ name: job.name, ok: true, ms: Date.now() - t, blocking });
  } catch {
    results.push({ name: job.name, ok: false, ms: Date.now() - t, blocking });
    console.log(`  ${Y}(${job.name} exited non-zero — continuing; often just means it found something)${X}`);
  }
}

console.log(`\n${B}══ summary ══${X}`);
for (const r of results) {
  const tag = r.blocking ? ` ${R}[blocking]${X}` : '';
  console.log(`  ${r.ok ? G + '✓' : R + '✗'}${X} ${r.name}${tag} ${D}(${(r.ms / 1000).toFixed(1)}s)${X}`);
}
const nonZero = results.filter((r) => !r.ok).length;
console.log(
  `\n${results.length - nonZero}/${results.length} clean. ` +
    'Findings queued to reckons-workspace/knowledge.pending.jsonl — review in Reckons.AI (Review tab → drain).',
);

// Advisory by default: a diagnostic that fails the build on every finding gets switched
// off, and then it protects nothing. Only jobs marked "blocking" can fail CI, and only
// under --ci — they guard the failures you cannot take back once pushed.
const failedBlocking = results.filter((r) => !r.ok && r.blocking);
if (CI && failedBlocking.length > 0) {
  console.log(
    `\n${R}${B}BLOCKING:${X} ${failedBlocking.map((r) => r.name).join(', ')} failed. ` +
      'This is not advisory — the build stops here.',
  );
  process.exit(1);
}
process.exit(0);
