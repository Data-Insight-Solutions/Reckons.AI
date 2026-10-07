/**
 * npm run agent:queue — the local-job queue a session worker drains (F74.7).
 *
 *   queue.ts add --name=<job> --cwd=<dir> [--priority=n] [--cpu] -- <argv…>   append one job (argv, never a shell string; --cpu = script tier, skips the GPU gate)
 *   queue.ts list                                                     queued jobs, then recurring jobs and when each is due
 *   queue.ts pause | resume                                           create / remove the PAUSE file; while it exists the worker starts nothing
 *   queue.ts drop <id>                                                remove a queued job (recorded as dropped)
 *   queue.ts seed-standard                                            add the standard local batch, skipping any already queued
 *   queue.ts enqueue-due                                              add each overdue recurring job once (the worker does this itself)
 *
 * The worker is scripts/agent/queue-worker.ts; it runs only while the session heartbeat is fresh.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mainCheckoutRoot } from '../offline/lib/main-workspace.js';
import { addJobs, isPaused, mutateQueue, newJob, orderQueue, queuePath, readDone, readQueue, setPaused, type QueueJob } from './session-queue.js';
import { doneSuccesses, dueAll, dueLabel, loadRecurring, mergeSuccesses, selectDue } from './session-schedule.js';

const git = (cwd: string, args: string[]): string => {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
};

/** Linked worktrees whose branch is not an ancestor of origin/dev: the work still worth a local review. */
export function unmergedWorktrees(root: string): { path: string; branch: string }[] {
  const out: { path: string; branch: string }[] = [];
  let cur: { path?: string; branch?: string; head?: string } = {};
  const flush = () => {
    if (cur.path && cur.branch && cur.head && cur.path !== root && existsSync(cur.path)) {
      const merged = execFileSyncOk(root, ['merge-base', '--is-ancestor', cur.head, 'origin/dev']);
      if (!merged) out.push({ path: cur.path, branch: cur.branch });
    }
    cur = {};
  };
  for (const line of git(root, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line === '') flush();
    else if (line.startsWith('worktree ')) cur.path = line.slice(9);
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  flush();
  return out;
}

function execFileSyncOk(cwd: string, args: string[]): boolean {
  try { execFileSync('git', args, { cwd, stdio: 'ignore' }); return true; } catch { return false; }
}

/** The standard batch as jobs. Pure given its inputs (the worktree list and the tsx binary). */
export function standardBatch(root: string, tsx: string, worktrees: { path: string; branch: string }[]): QueueJob[] {
  const off = (f: string) => path.join(root, 'scripts', 'offline', f);
  const j = (name: string, argv: string[], cwd = root) => newJob(name, cwd, argv);
  return [
    ...worktrees.map((w) => j(`code-review:${w.branch}`, [tsx, off('code-review.ts'), '--base=origin/dev', '--worktree'], w.path)),
    j('describe-entities', [tsx, off('describe-entities.ts'), '--limit=40']),
    j('docs-review', [tsx, off('docs-review.ts'), '--limit=30']),
    j('docs-expand', [tsx, off('docs-expand.ts'), '--limit=20']),
    j('distill-decisions', [tsx, off('distill-decisions.ts'), '--limit=20', '--pending']),
    j('layer-classify', [tsx, off('layer-classify.ts')]),
    j('extraction-score', [tsx, off('extraction-score.ts'), '--pending']),
    ...['node', 'graph', 'space', 'source', 'set', 'statement'].map((w) => j(`term-senses:${w}`, [tsx, off('term-senses.ts'), `--word=${w}`])),
    j('offline-all-agent', ['npm', 'run', 'offline:all', '--', '--tier=agent']),
  ];
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const root = mainCheckoutRoot();
  const sep = rest.indexOf('--');
  const flags = sep < 0 ? rest : rest.slice(0, sep);
  const argv = sep < 0 ? [] : rest.slice(sep + 1);
  const flag = (k: string) => flags.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

  if (cmd === 'add') {
    const name = flag('name');
    const cwd = flag('cwd');
    const priority = flag('priority') !== undefined ? Number(flag('priority')) : undefined;
    if (!name || !cwd || argv.length === 0 || (priority !== undefined && !Number.isFinite(priority))) {
      console.error('Usage: queue.ts add --name=<job> --cwd=<dir> [--priority=n] -- <argv…>');
      process.exit(2);
    }
    const r = addJobs([newJob(name, path.resolve(cwd), argv, priority, flags.includes('--cpu') ? false : undefined)]);
    console.log(r.add.length ? `queued ${name} (${r.add[0].id})` : `already queued: ${name} in ${cwd}`);
  } else if (cmd === 'list') {
    const q = orderQueue(readQueue());
    console.log(`QUEUE ${queuePath()} — ${q.length} job(s)${isPaused() ? ' — PAUSED (queue.ts resume)' : ''}`);
    for (const j of q) console.log(`  ${j.id}  ${j.name}${j.priority ? ` (p${j.priority})` : ''}  ${j.cwd}  ${j.argv.join(' ').slice(0, 90)}`);
    const { jobs, successes } = loadRecurring(root);
    const due = dueAll(jobs, mergeSuccesses(successes, doneSuccesses(readDone())), Date.now());
    console.log(`RECURRING — ${due.length}: ${due.map(dueLabel).join(', ') || 'none'}`);
  } else if (cmd === 'pause' || cmd === 'resume') {
    setPaused(cmd === 'pause');
    console.log(cmd === 'pause' ? 'paused: the worker will start nothing (a running job finishes)' : 'resumed');
  } else if (cmd === 'drop') {
    const id = rest[0];
    if (!id) { console.error('Usage: queue.ts drop <id>'); process.exit(2); }
    const dropped = mutateQueue((jobs) => {
      const hit = jobs.find((j) => j.id === id);
      return { jobs: jobs.filter((j) => j.id !== id), done: hit ? [{ ...hit, finishedAt: new Date().toISOString(), outcome: 'dropped' as const }] : [], result: hit };
    });
    console.log(dropped ? `dropped ${dropped.name}` : `no queued job ${id}`);
    process.exit(dropped ? 0 : 1);
  } else if (cmd === 'seed-standard') {
    const tsxBin = path.join(root, 'node_modules', '.bin', 'tsx');
    const batch = standardBatch(root, existsSync(tsxBin) ? tsxBin : 'tsx', unmergedWorktrees(root));
    const r = addJobs(batch);
    console.log(`seeded ${r.add.length} job(s); ${r.skipped.length} already queued`);
  } else if (cmd === 'enqueue-due') {
    const { jobs, successes } = loadRecurring(root);
    const statuses = dueAll(jobs, mergeSuccesses(successes, doneSuccesses(readDone())), Date.now());
    const r = addJobs(selectDue(statuses, []));
    console.log(`enqueued ${r.add.length} due job(s); ${r.skipped.length} already queued`);
  } else {
    console.error('Usage: queue.ts add|list|drop|pause|resume|seed-standard|enqueue-due');
    process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
