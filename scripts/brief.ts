#!/usr/bin/env npx tsx
/**
 * `npm run brief` — the session-start orientation, for free (SCRIPT tier).
 *
 * WHY: every session begins the same way. Opus reads HANDOFF.md, runs `git log`, greps the
 * roadmap, counts the pending queue, checks which PR is open, works out what is blocked. That
 * is several thousand tokens of RE-DERIVING FACTS THAT ARE ALREADY WRITTEN DOWN, at frontier
 * prices, before a single useful thought.
 *
 * Every one of those questions is checkable by a rule. So it is a script, it costs nothing,
 * and it cannot hallucinate a branch that does not exist (F74.3: anything Opus does twice
 * becomes a script — and this one it does EVERY time).
 *
 * Deliberately terse. This output is read by a model with a token budget, not by a human
 * browsing. Every line has to earn its place.
 *
 * Usage:  npm run brief          human-readable
 *         npm run brief -- --json
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { Parser } from 'n3';

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', X = '\x1b[0m';
const JSON_OUT = process.argv.includes('--json');

const sh = (cmd: string): string => {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

// ── Where are we? ───────────────────────────────────────────────────────────
const branch = sh('git rev-parse --abbrev-ref HEAD');
const ahead = sh('git rev-list --count origin/dev..HEAD') || '0';
const dirty = sh('git status --porcelain').split('\n').filter(Boolean).length;
const lastCommits = sh('git log --oneline -3').split('\n').filter(Boolean);

// PR, if the gh CLI is available and authenticated. Absent is not an error.
let pr = '';
try {
  pr = sh(`gh pr list --head ${branch} --json number,baseRefName,title --jq '.[0] | "#\\(.number) → \\(.baseRefName): \\(.title)"'`);
} catch {
  /* no gh; fine */
}

// ── What is waiting on Matt? ────────────────────────────────────────────────
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const ANSWERS = 'reckons-workspace/knowledge.answers.jsonl';
const readJsonl = (f: string): any[] =>
  existsSync(f)
    ? readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

const pending = readJsonl(PENDING);
const answered = new Set(readJsonl(ANSWERS).map((a) => `${a.subject}|${a.predicate}`));
const openQuestions = pending.filter(
  (p) => p.type === 'question' && !answered.has(`${p.subject}|${p.predicate}`),
);
const driftWarnings = pending.filter((p) => p.type === 'drift-warning');

// ── The task queue ─────────────────────────────────────────────────────────
const TASKS = 'reckons-workspace/tasks.ttl';
const STATE = 'reckons-workspace/tasks.state.ttl';
interface T { iri: string; state: string; label: string }
let tasks: T[] = [];
if (existsSync(TASKS)) {
  try {
    const q = new Parser().parse(readFileSync(TASKS, 'utf8'));
    const sq = existsSync(STATE) ? new Parser().parse(readFileSync(STATE, 'utf8')) : [];
    const iris = [...new Set(
      q.filter((x) => x.predicate.value === RDF_TYPE && x.object.value === 'urn:kbase:type/AgentTask').map((x) => x.subject.value),
    )];
    tasks = iris.map((iri) => ({
      iri,
      label:
        q.find((x) => x.subject.value === iri && x.predicate.value.endsWith('#label'))?.object.value ??
        iri.split('/').pop()!,
      state:
        sq.find((x) => x.subject.value === iri && x.predicate.value === `${KPRED}task-state`)?.object.value ??
        q.find((x) => x.subject.value === iri && x.predicate.value === `${KPRED}task-state`)?.object.value ??
        'open',
    }));
  } catch {
    /* the runner owns parse errors */
  }
}
const waiting = tasks.filter((t) => t.state === 'waiting');
const failed = tasks.filter((t) => t.state === 'failed');

// ── What is actually in progress on the roadmap? ───────────────────────────
const ROADMAP = 'static/reckons-roadmap.ttl';
interface F { id: string; label: string; status: string }
let inProgress: F[] = [];
if (existsSync(ROADMAP)) {
  try {
    const q = new Parser().parse(readFileSync(ROADMAP, 'utf8'));
    const get = (s: string, p: string) =>
      q.find((x) => x.subject.value === s && x.predicate.value === p)?.object.value;
    const subjects = [...new Set(q.filter((x) => x.predicate.value === `${KPRED}has-status`).map((x) => x.subject.value))];
    inProgress = subjects
      .map((s) => ({
        id: get(s, `${KPRED}feature-id`) ?? '—',
        label: get(s, 'http://www.w3.org/2000/01/rdf-schema#label') ?? s.split('/').pop()!,
        status: get(s, `${KPRED}has-status`) ?? '',
      }))
      .filter((f) => f.status === 'in-progress' || f.status === 'scaffolded')
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    /* graph-lint owns parse errors */
  }
}

// ── Report ─────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ branch, ahead: Number(ahead), dirty, pr, openQuestions: openQuestions.length, driftWarnings: driftWarnings.length, tasks: { total: tasks.length, waiting: waiting.length, failed: failed.length }, inProgress }, null, 2));
  process.exit(0);
}

console.log(`${B}Brief${X} ${D}— everything below is a FACT, read from the repo. Nothing here cost a token.${X}\n`);

console.log(`${B}where${X}`);
console.log(`  branch   ${branch}${ahead !== '0' ? ` ${D}(${ahead} ahead of dev)${X}` : ''}`);
if (pr) console.log(`  PR       ${pr}`);
if (dirty) console.log(`  ${Y}uncommitted: ${dirty} file(s)${X}`);
for (const c of lastCommits) console.log(`  ${D}${c}${X}`);

// The thing a session most needs to know, and the thing it most often re-derives.
console.log(`\n${B}waiting on Matt${X}`);
if (openQuestions.length === 0 && waiting.length === 0) {
  console.log(`  ${G}nothing — he is not blocking you${X}`);
} else {
  for (const t of waiting) console.log(`  ${Y}task WAITING${X} ${t.label}`);
  for (const q of openQuestions.slice(0, 5)) {
    console.log(`  ${Y}?${X} ${(q.question ?? `${q.subject} ${q.predicate}`).slice(0, 88)}`);
  }
  if (openQuestions.length > 5) console.log(`  ${D}… and ${openQuestions.length - 5} more open question(s)${X}`);
}

console.log(`\n${B}queue${X}`);
console.log(
  `  ${tasks.length} task(s)` +
    (failed.length ? `  ${R}${failed.length} FAILED${X}` : '') +
    `  ${D}· run 'npm run agent:run' — it is free${X}`,
);
console.log(`  ${pending.length} pending fact(s) to triage${driftWarnings.length ? `, ${R}${driftWarnings.length} drift-warning(s)${X}` : ''}`);

if (inProgress.length) {
  console.log(`\n${B}in flight (roadmap says so, not memory)${X}`);
  for (const f of inProgress) console.log(`  ${f.id.padEnd(7)} ${D}${f.status.padEnd(11)}${X} ${f.label}`);
}

console.log(
  `\n${D}Next: read HANDOFF.md. Then 'npm run agent:run' (free) before you spend anything.${X}`,
);
