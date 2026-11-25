/**
 * THE ROADMAP SCHEDULER (Matt, 2026-11-25): "we should always look forward in roadmap, compare with current state, and
 * schedule development and merge tasks in job queue. It should build what is defined with the user."
 *
 * Why it exists: decisions made WITH Matt were recorded in the roadmap and then waited for a second ask, because
 * nothing read the roadmap forward. scripts/agent/orchestrate.ts triages the review queue of findings; this reads the
 * PLAN. It is deterministic (script tier): it compares each planned or in-progress item that Matt decided (a
 * kpred:decided naming MATT) and that has a kpred:done-test against the current state, and says what is next.
 *
 *   npx tsx scripts/agent/roadmap-scheduler.ts            what it would do (the default; changes nothing)
 *   npx tsx scripts/agent/roadmap-scheduler.ts --apply    also create the worktree and queue the deputy build
 *   npx tsx scripts/agent/roadmap-scheduler.ts --json
 *   npx tsx scripts/agent/roadmap-scheduler.ts --apply --only=F139.2,F223.12   queue just those
 *
 * Per item it reports one of:
 *   DONE          status functional or production
 *   BLOCKED       a kpred:depends-on item is not functional yet (named)
 *   QUEUED        a job named build-<id> is queued or running
 *   BRANCH        a branch for it exists: it needs an overseer, then a merge into the next integration batch
 *   BUILD         nothing is under way: --apply creates a worktree from origin/dev and queues a deputy build whose
 *                 brief is generated from the item itself (its label, Matt's words, description, measurements, done-test)
 * Overseers (Claude) and merges stay with the head session for now; BRANCH items are listed so none is forgotten.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { Parser, type Quad } from 'n3';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const KB = 'urn:kbase:concept/', P = 'urn:kbase:predicate/';
const DONE = new Set(['functional', 'production']);
/** A dependency that exists in code (scaffolded or better) does not block the next build. */
const AVAILABLE = new Set(['scaffolded', 'functional', 'production']);
const OPEN = new Set(['planned', 'in-progress', 'scaffolded']);

export type Item = {
  iri: string; id: string; label: string; status: string; priority?: string; releases: string[];
  decided: string[]; description?: string; measured: string[]; remaining: string[]; doneTest: string; dependsOn: string[];
};
export type Action = { item: Item; action: 'DONE' | 'BLOCKED' | 'QUEUED' | 'BRANCH' | 'BUILD' | 'CONTINUE'; why: string; priority: number };

/** Pure: the items Matt decided that the scheduler should look at, from the roadmap's quads. */
export function readItems(quads: Quad[]): Item[] {
  const by = new Map<string, Map<string, string[]>>();
  for (const q of quads) {
    const m = by.get(q.subject.value) ?? new Map<string, string[]>();
    const k = q.predicate.value; m.set(k, [...(m.get(k) ?? []), q.object.value]); by.set(q.subject.value, m);
  }
  const items: Item[] = [];
  for (const [iri, m] of by) {
    const id = m.get(P + 'feature-id')?.[0];
    const status = m.get(P + 'has-status')?.[0];
    const decided = (m.get(P + 'decided') ?? []).filter((d) => /\bMATT\b/.test(d));
    const doneTest = m.get(P + 'done-test')?.[0];
    if (!id || !status || !doneTest || decided.length === 0) continue;
    const parentReleases = (m.get(P + 'part-of') ?? []).filter((x) => x.startsWith(KB + 'release-'));
    items.push({
      iri, id, status, decided, doneTest,
      label: m.get('http://www.w3.org/2000/01/rdf-schema#label')?.[0] ?? id,
      priority: m.get(P + 'priority')?.[0],
      releases: parentReleases.map((r) => r.slice(KB.length)),
      description: m.get(P + 'description')?.[0],
      measured: m.get(P + 'measured') ?? [],
      remaining: m.get(P + 'remaining') ?? [],
      dependsOn: m.get(P + 'depends-on') ?? [],
    });
  }
  return items;
}

/** Pure: the branch-name stem for a feature id, F309.1 -> f309-1. */
export const stemOf = (id: string) => id.toLowerCase().replace(/\./g, '-');

/** Pure: what to do with each item, given the state of statuses, branches and the queue. */
export function decide(items: Item[], state: { statusOf: (iri: string) => string | undefined; branches: { name: string; subjects: string[] }[]; jobs: string[] }): Action[] {
  const out: Action[] = [];
  for (const item of items) {
    const prio = (item.releases.some((r) => r === 'release-0-2-9') ? 6 : item.releases.length ? 4 : 3) + (item.priority === 'high' ? 1 : 0);
    if (DONE.has(item.status)) { out.push({ item, action: 'DONE', why: item.status, priority: prio }); continue; }
    if (!OPEN.has(item.status)) continue;
    const blockers = item.dependsOn.filter((d) => !AVAILABLE.has(state.statusOf(d) ?? ''));
    if (blockers.length) { out.push({ item, action: 'BLOCKED', why: 'waits on ' + blockers.map((b) => b.replace(KB, 'kb:')).join(', '), priority: prio }); continue; }
    const stem = stemOf(item.id);
    if (state.jobs.some((j) => j === `build-${stem}`)) { out.push({ item, action: 'QUEUED', why: `job build-${stem}`, priority: prio }); continue; }
    // Work under way = an UNMERGED branch named for the item, or one whose own commits name its id (work often lands on
    // a branch named for something else, e.g. F292.4 on feat/f300-6-story-variety).
    const idRe = new RegExp(`(^|[^0-9.])${item.id.replace(/\./g, '\\.')}(?![0-9.])`);
    const br = state.branches.find((b) => new RegExp(`(^|/)(feat|plan|fix)/${stem}(-|$)`).test(b.name) || b.subjects.some((t) => idRe.test(t)));
    if (br) { out.push({ item, action: 'BRANCH', why: `${br.name}: overseer, then merge into the next integration batch`, priority: prio }); continue; }
    // Something already exists for a scaffolded or in-progress item: the next job CONTINUES it (its kpred:remaining).
    out.push(item.status === 'planned' ? { item, action: 'BUILD', why: 'nothing under way', priority: prio }
      : { item, action: 'CONTINUE', why: `${item.status}; nothing under way now`, priority: prio });
  }
  return out.sort((a, b) => b.priority - a.priority || a.item.id.localeCompare(b.item.id, undefined, { numeric: true }));
}

/** Pure: a deputy brief generated from the item itself, so the build follows what was decided with Matt. */
export function briefFor(item: Item, worktree: string, branch: string): string {
  return [
    `You are the local deputy. Work ONLY in ${worktree}, branch ${branch} (from dev). Read AGENTS.md first.`,
    `BUILD ${item.id}: ${item.label}`,
    `It is ${item.iri.replace(KB, 'kb:')} in static/reckons-roadmap.ttl. Read that entity in full first; what follows is quoted from it.`,
    '', 'MATT DECIDED (these bind you):', ...item.decided.map((d) => '- ' + d),
    ...(item.description ? ['', 'WHAT IT IS:', item.description] : []),
    ...(item.measured.length ? ['', 'ALREADY MEASURED (do not redo):', ...item.measured.map((m) => '- ' + m)] : []),
    ...(item.remaining.length ? ['', `IT IS ${item.status.toUpperCase()}; WHAT REMAINS (do this, not a rebuild):`, ...item.remaining.map((r) => '- ' + r)] : []),
    '', 'DONE WHEN (this is the test of your work):', item.doneTest,
    '', `GRAPH: when it is built, a dated kpred:progress line on the entity saying what is built and what is not, kpred:tested-by for test files, kpred:has-status only as the done-test allows, kpred:has-file for new files in static/reckons-codebase.ttl.`,
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply'), json = args.includes('--json');
  // --max=N: queue at most N new builds in one run (the local queue runs one job at a time).
  const max = Number(args.find((a) => a.startsWith('--max='))?.slice(6) ?? 2);
  // --only=F139.2,F223.12: the head session steers which items are queued (e.g. skips one whose code is on an unmerged branch).
  const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);
  // --base=<ref>: start new worktrees from this ref instead of origin/dev (when the item's plan or prerequisites are on
  // a branch not yet merged).
  const base = args.find((a) => a.startsWith('--base='))?.slice(7) || 'origin/dev';
  const quads = new Parser().parse(readFileSync(path.join(ROOT, 'static/reckons-roadmap.ttl'), 'utf8'));
  const statusByIri = new Map<string, string>();
  for (const q of quads) if (q.predicate.value === P + 'has-status') statusByIri.set(q.subject.value, q.object.value);
  const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  // Only branches NOT yet merged into dev count as work under way; each with its own commits' subjects.
  const unmerged = git('branch', '-a', '--no-merged', 'origin/dev', '--format=%(refname:short)').split('\n').filter(Boolean)
    .filter((b) => !b.startsWith('origin/HEAD') && b !== 'origin');
  const branches = unmerged.map((name) => ({ name, subjects: git('log', '--format=%s', `origin/dev..${name}`).split('\n').filter(Boolean) }));
  const stateDir = path.join(process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local/state'), 'reckons');
  const jobs: string[] = [];
  for (const f of ['jobs/queue.jsonl', 'jobs/current.json']) {
    const p = path.join(stateDir, f); if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/"name"\s*:\s*"([^"]+)"/g)) jobs.push(m[1]);
  }
  const actions = decide(readItems(quads), { statusOf: (iri) => statusByIri.get(iri), branches, jobs });
  if (json) { console.log(JSON.stringify(actions.map((a) => ({ id: a.item.id, action: a.action, why: a.why, priority: a.priority })), null, 2)); return; }
  for (const a of actions.filter((x) => x.action !== 'DONE')) console.log(`${a.action.padEnd(8)} p${a.priority}  ${a.item.id.padEnd(8)} ${a.item.label.slice(0, 70)}  — ${a.why}`);
  console.log(`\n${actions.filter((a) => a.action === 'DONE').length} done; ${actions.filter((a) => a.action === 'BUILD').length} to build; ${actions.filter((a) => a.action === 'CONTINUE').length} to continue; ${actions.filter((a) => a.action === 'BRANCH').length} branches to oversee and merge; ${actions.filter((a) => a.action === 'BLOCKED').length} blocked.`);
  if (!apply) { console.log(`(dry run: --apply creates worktrees and queues the top ${max} BUILD items; --max=N to change)`); return; }
  const common = path.join(stateDir, 'briefs/common-2026-11-24.md');
  for (const a of actions.filter((x) => (x.action === 'BUILD' || x.action === 'CONTINUE') && (!only || only.includes(x.item.id))).slice(0, max)) {
    const stem = stemOf(a.item.id), branch = `feat/${stem}-scheduled`, wt = path.resolve(ROOT, '..', `tripleNotes-${stem}`);
    if (!existsSync(wt)) {
      git('fetch', '-q', 'origin');
      git('worktree', 'add', '-q', wt, '-b', branch, base);
      symlinkSync(path.join(ROOT, 'node_modules'), path.join(wt, 'node_modules'));
    }
    mkdirSync(path.join(stateDir, 'briefs'), { recursive: true });
    const briefPath = path.join(stateDir, 'briefs', `${stem}-scheduled.md`);
    writeFileSync(briefPath, briefFor(a.item, wt, branch).replace('(from dev)', `(from ${base})`) + (existsSync(common) ? '\n\n' + readFileSync(common, 'utf8') : ''));
    execFileSync('npx', ['tsx', 'scripts/agent/queue.ts', 'add', `--name=build-${stem}`, `--cwd=${wt}`, '--gpu=0', `--priority=${a.priority}`, '--',
      'bash', 'scripts/agent/local-claude.sh', '-p', readFileSync(briefPath, 'utf8'), '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(git:*),Bash(npx:*),Bash(npm:*),Bash(node:*),Bash(ls:*),mcp__reckons__kb_get_entity,mcp__reckons__kb_search'],
      { cwd: ROOT, stdio: 'inherit' });
  }
}

if (process.argv[1] && process.argv[1].endsWith('roadmap-scheduler.ts')) main();
