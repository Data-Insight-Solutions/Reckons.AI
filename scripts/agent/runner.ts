#!/usr/bin/env npx tsx
/**
 * The runner (F87 / kb:orch-task-vocab) — drain the task queue.
 *
 * The queue is the contract and the runner is pluggable. This is the FIRST runner and
 * deliberately the dumbest one: script tier, deterministic, no model, no cloud. It exists to
 * prove the loop closes — claim, execute, verify, write the outcome back — before anything
 * expensive is allowed near it.
 *
 * ┌─ SECURITY: EXECUTING A GRAPH IS EXECUTING DATA ────────────────────────────────────────┐
 * │                                                                                        │
 * │ A task carries a shell command. Running commands out of a graph is fine for a graph    │
 * │ that lives in this repo — anyone who can write static/*.ttl can already commit code, so │
 * │ it opens no new door. It is CATASTROPHIC for a graph a user imported from someone else:│
 * │ "here is an interesting knowledge base" would become remote code execution.            │
 * │                                                                                        │
 * │ So the runner executes tasks ONLY from a local file passed explicitly on the command    │
 * │ line, and it will not read a task queue out of the app's IndexedDB, an imported graph,  │
 * │ or anything a user could have been handed. That boundary is the whole safety argument   │
 * │ and it must not be widened without a better one.                                        │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * What it does, per task:
 *   1. CLAIM      take a lease. A second runner must not take the same task.
 *   2. EXECUTE    run kpred:command.
 *   3. VERIFY     run kpred:done-when. Exit 0 means done. THE COMMAND'S OWN OPINION OF
 *                 ITSELF IS NOT EVIDENCE — a task is complete when an independent check
 *                 says so, not when the thing that did the work says it worked.
 *   4. REPORT     write kpred:outcome back into the graph, INCLUDING failure and including
 *                 "I did nothing, and here is why". Silence must never look like success.
 *
 * Usage:
 *   npx tsx scripts/agent/runner.ts --graph reckons-workspace/tasks.ttl
 *   npx tsx scripts/agent/runner.ts --graph … --dry-run    show what would run, run nothing
 *   npx tsx scripts/agent/runner.ts --graph … --once       take a single task and stop
 */
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { Parser, Writer, DataFactory, type Quad } from 'n3';

const { namedNode, literal, quad } = DataFactory;

const KPRED = 'urn:kbase:predicate/';
const KTYPE = 'urn:kbase:type/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const AGENT_TASK = `${KTYPE}AgentTask`;
const JOURNAL = 'reckons-workspace/runner.log.jsonl';
const PENDING = 'reckons-workspace/knowledge.pending.jsonl';
const ANSWERS = 'reckons-workspace/knowledge.answers.jsonl';
const LEASE_MS = 30 * 60 * 1000;

/**
 * A task's command exits with this when it cannot proceed WITHOUT A HUMAN DECISION.
 *
 * This is the mechanism behind "let a user define it, and it asks refining questions if
 * necessary". Without it, a task that meets an ambiguity has exactly two bad options: GUESS,
 * or FAIL. A guess silently entered into a knowledge graph is worse than a stalled task — it
 * is a lie the graph will now repeat on your behalf. So there is a third option: SUSPEND.
 *
 * The command emits a partial fact (scripts/agent/ask.ts) naming what it needs and what it
 * blocks, then exits 42. The runner does not mark it done, and does not mark it failed —
 * neither is true. It marks it WAITING, and moves on to work that is not stuck. When the
 * answer lands, the task becomes runnable again on its own.
 *
 * The user is never a blocking call, and the agent never guesses. Both, at once.
 */
const NEEDS_ANSWER = 42;

/** Max times a task may fail before the queue stops offering it. "However long it takes" is
 *  a promise about PATIENCE, not about retrying a broken thing until the end of the world. */
const MAX_ATTEMPTS = 3;

const B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', X = '\x1b[0m';

const argv = process.argv.slice(2);
const flag = (n: string) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};
const DRY = argv.includes('--dry-run');
const ONCE = argv.includes('--once');
const GRAPH = flag('graph');
const RUNNER_ID = flag('id') ?? `script-runner@${process.pid}`;

// ── The trust boundary, enforced rather than documented ─────────────────────
if (!GRAPH) {
  console.error(`${R}--graph <file.ttl> is required.${X}`);
  console.error(
    `${D}The runner executes commands out of a graph. It will only do that for a LOCAL file you\n` +
      `name explicitly — never an imported or user-supplied graph, where that would be remote\n` +
      `code execution dressed up as a knowledge base.${X}`,
  );
  process.exit(2);
}
if (!existsSync(GRAPH)) {
  console.error(`${R}No such graph: ${GRAPH}${X}`);
  process.exit(2);
}

// ── Read the queue, then the state, layered on top ─────────────────────────
//
// THE AUTHORED QUEUE AND THE MACHINE-WRITTEN STATE ARE DIFFERENT FILES, and the first version
// of this runner proved why. It rewrote outcomes into the authored .ttl with a regex, which
// could not see `kpred:task-state "open"` inside a prefixed predicate-list — so the graph ended
// up asserting BOTH "open" and "done", the parser read the first, and the runner cheerfully
// re-ran every completed task forever.
//
// It is the project's own rule, learned again the hard way: never hand-edit (or machine-edit)
// a file that a human authors. State goes in its own file and is layered over the top. The
// authored queue keeps its comments and stays readable; the state file is disposable.
const STATE = GRAPH.replace(/\.ttl$/, '.state.ttl');

let quads: Quad[];
try {
  quads = new Parser().parse(readFileSync(GRAPH, 'utf8')) as Quad[];
} catch (e) {
  console.error(`${R}The task queue does not parse: ${GRAPH}${X}`);
  console.error(`${D}${e instanceof Error ? e.message : e}${X}`);
  process.exit(2);
}

// A CORRUPT STATE FILE MUST NOT KILL THE RUNNER.
//
// It did, once, and the stack trace was the whole output. That is the failure class this
// project keeps meeting: the thing that was supposed to keep watch is the thing that died,
// and it died loudly enough to look like a crash rather than a condition to handle. The state
// file is DERIVED — the authored queue is the truth — so an unreadable one is a recoverable
// problem: say so, treat the state as empty, and re-derive it. Never take the queue down
// because the notebook got smudged.
let stateQuads: Quad[] = [];
if (existsSync(STATE)) {
  try {
    stateQuads = new Parser().parse(readFileSync(STATE, 'utf8')) as Quad[];
  } catch (e) {
    console.log(
      `${Y}!${X} state file is unreadable (${STATE}) — ${D}${e instanceof Error ? e.message.split('\n')[0] : e}${X}`,
    );
    console.log(
      `${D}  It is derived, not authored, so it is being IGNORED and rebuilt. Tasks may re-run.\n` +
        `  If that is wrong, stop and look — do not let a smudged notebook decide what work happens.${X}\n`,
    );
    stateQuads = [];
  }
}

interface Task {
  iri: string;
  goal: string;
  tier: string;
  command?: string;
  doneWhen?: string;
  blockedBy: string[];
  state: string;
  claimedBy?: string;
  claimExpires?: number;
  outcome?: string;
  /** Recurrence, e.g. "30m", "6h", "7d". A recurring task is never "done" — it is DUE AGAIN. */
  every?: string;
  /** Epoch ms. Not runnable before this. */
  dueAt?: number;
  lastRun?: number;
  /** Consecutive failures. Bounded by MAX_ATTEMPTS. */
  attempts?: number;
}

const taskIris = new Set(
  quads.filter((q) => q.predicate.value === RDF_TYPE && q.object.value === AGENT_TASK).map((q) => q.subject.value),
);

/** State WINS over the authored queue — that is what makes it state. */
const one = (iri: string, p: string) => {
  const fromState = stateQuads.find((q) => q.subject.value === iri && q.predicate.value === `${KPRED}${p}`);
  if (fromState) return fromState.object.value;
  return quads.find((q) => q.subject.value === iri && q.predicate.value === `${KPRED}${p}`)?.object.value;
};
const many = (iri: string, p: string) =>
  quads.filter((q) => q.subject.value === iri && q.predicate.value === `${KPRED}${p}`).map((q) => q.object.value);

const tasks: Task[] = [...taskIris].map((iri) => ({
  iri,
  goal: one(iri, 'goal') ?? '',
  tier: one(iri, 'tier') ?? 'frontier',
  command: one(iri, 'command'),
  doneWhen: one(iri, 'done-when'),
  blockedBy: many(iri, 'blocked-by'),
  state: one(iri, 'task-state') ?? 'open',
  claimedBy: one(iri, 'claimed-by'),
  claimExpires: Number(one(iri, 'claim-expires') ?? 0) || undefined,
  outcome: one(iri, 'outcome'),
  every: one(iri, 'every'),
  dueAt: Number(one(iri, 'due-at') ?? 0) || undefined,
  lastRun: Number(one(iri, 'last-run') ?? 0) || undefined,
  attempts: Number(one(iri, 'attempts') ?? 0) || 0,
}));

/**
 * "30m" | "6h" | "7d" -> milliseconds.
 *
 * DELIBERATELY NOT CRON. Cron expresses "at 03:40 on Tuesdays", which is a promise this system
 * cannot keep: it assumes a machine that is awake, in a timezone, with a scheduler that fires.
 * We already learned what that promise is worth — the cron fired exactly on schedule, produced
 * nothing, reported nothing, and still displayed a future run time (kb:local-orchestration).
 *
 * An INTERVAL makes a weaker and therefore honest claim: "not more often than this". Whichever
 * runner wakes next drains whatever is due. Nothing is missed by a machine being asleep; the
 * work is simply done when someone next shows up. Drain, do not schedule.
 */
function parseEvery(v: string | undefined): number | null {
  if (!v) return null;
  const m = v.trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  return n * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000);
}

const now = Date.now();
const doneIris = new Set(tasks.filter((t) => t.state === 'done').map((t) => t.iri));

// ── Is the local agent tier available at all? ──────────────────────────────
//
// A local-agent task needs Ollama. If it is not up, the task is NOT failed — nothing is wrong
// with it, the machine simply cannot run it right now. Marking it failed would burn an attempt
// and eventually make the queue give up on perfectly good work because a service was down.
//
// This is the same distinction the whole system rests on: "could not run" is not "ran and did
// not work", and a system that conflates them will quietly abandon things that were fine.
const OLLAMA = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
let ollamaUp = false;
try {
  execSync(`curl -sf -m 3 -o /dev/null ${OLLAMA}/api/tags`, { stdio: 'ignore', shell: '/bin/bash' });
  ollamaUp = true;
} catch {
  ollamaUp = false;
}

// ── What has the human actually answered? ──────────────────────────────────
//
// A question is a partial fact in the pending queue that names the work it BLOCKS. It is
// answered when a line for the same subject+predicate appears in the answers file — which is
// what the app writes when someone fills the object in, whether they did it in the review
// queue or by talking to Shelly. Both routes resolve the same underlying fact, which is the
// whole point of F32/F80: the user chooses the interface, not the mechanism.
const readJsonl = (f: string): any[] => {
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try { return [JSON.parse(l)]; } catch { return []; }
    });
};

const answeredKeys = new Set(readJsonl(ANSWERS).map((a) => `${a.subject}|${a.predicate}`));
/** taskIri -> the questions blocking it that are still UNANSWERED. */
const openQuestionsFor = new Map<string, string[]>();
for (const q of readJsonl(PENDING)) {
  if (q.type !== 'question' || !q.blocks) continue;
  if (answeredKeys.has(`${q.subject}|${q.predicate}`)) continue;
  const list = openQuestionsFor.get(q.blocks) ?? [];
  list.push(q.question ?? `${q.subject} ${q.predicate} ?`);
  openQuestionsFor.set(q.blocks, list);
}

const resolved = (iri: string) => doneIris.has(iri);

/** Why this task cannot run right now — the same rules as rdf/agent-task.ts. */
function blockedReason(t: Task): string | null {
  const interval = parseEvery(t.every);

  // A RECURRING TASK IS NEVER "DONE" — IT IS DUE AGAIN. Treating a completed run as terminal
  // is how a schedule silently becomes a one-shot.
  if (t.state === 'done' && interval === null) return 'already done';

  // Not yet due. This is the whole of "scheduling" here: no cron, no daemon, no timer — the
  // task simply is not ready, and whichever runner wakes next will find it when it is.
  if (t.dueAt !== undefined && now < t.dueAt) {
    const mins = Math.ceil((t.dueAt - now) / 60000);
    return `not due for ${mins}m${t.every ? ` (every ${t.every})` : ''}`;
  }

  if (!t.goal.trim()) return 'no goal';
  if (!t.doneWhen?.trim()) {
    return 'NO done-when — a task with no machine-checkable acceptance criterion is a wish, not a task';
  }
  if (t.tier !== 'script' && t.tier !== 'local-agent') {
    return `tier "${t.tier}" — this runner handles script and local-agent only`;
  }
  if (t.tier === 'local-agent' && !ollamaUp) {
    // NOT a failure. The work is fine; the machine is not ready. It waits.
    return `local-agent tier, but Ollama is not reachable at ${OLLAMA} — waiting, not failing`;
  }
  if (!t.command?.trim()) return 'no command to run';
  // Waiting on a human. Not failed, not done — ASKED. It comes back by itself when answered.
  const asked = openQuestionsFor.get(t.iri) ?? [];
  if (asked.length) return `WAITING on you — ${asked[0].slice(0, 90)}`;

  if ((t.attempts ?? 0) >= MAX_ATTEMPTS) {
    return `gave up after ${t.attempts} attempts — "however long it takes" is patience, not an infinite retry of a broken thing`;
  }

  const unresolved = t.blockedBy.filter((b) => !resolved(b));
  if (unresolved.length) return `blocked by ${unresolved.length}: ${unresolved.slice(0, 2).join(', ')}`;
  // An EXPIRED claim is not a blocker. That is the point of a lease: the runner died, and the
  // work must not die with it.
  if (t.claimedBy && t.claimExpires && now < t.claimExpires) return `claimed by ${t.claimedBy}`;
  return null;
}

// ── Write outcomes back into the graph ─────────────────────────────────────
//
// The graph is the record. A run that leaves no trace in it did not happen, as far as anyone
// looking at the queue tomorrow is concerned.
function setFacts(iri: string, facts: Record<string, string>) {
  if (DRY) return;
  // Rebuild the state file from parsed quads — no text surgery on anything, ever.
  const keep = (existsSync(STATE) ? (new Parser().parse(readFileSync(STATE, 'utf8')) as Quad[]) : []).filter(
    (q) => !(q.subject.value === iri && Object.keys(facts).some((p) => q.predicate.value === `${KPRED}${p}`)),
  );
  for (const [p, v] of Object.entries(facts)) {
    keep.push(quad(namedNode(iri), namedNode(`${KPRED}${p}`), literal(v)) as Quad);
  }
  const writer = new Writer({ format: 'Turtle' });
  writer.addQuads(keep);
  writer.end((err, result: string) => {
    if (err) throw err;
    writeFileSync(
      STATE,
      `# GENERATED by scripts/agent/runner.ts — do not hand-edit.\n` +
        `# The authored queue is ${path.basename(GRAPH!)}; this is only the machine's record of\n` +
        `# what it claimed, ran, and what came of it. Delete it to reset the queue.\n\n` +
        result,
    );
  });
}

function journal(entry: object) {
  try {
    appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), runner: RUNNER_ID, ...entry }) + '\n');
  } catch {
    /* the journal is a convenience; the graph is the record */
  }
}

// ── Drain ──────────────────────────────────────────────────────────────────
console.log(`${B}Runner${X} ${D}— ${GRAPH} · ${RUNNER_ID}${D}${DRY ? ' · DRY RUN' : ''}${X}\n`);

const runnable = tasks.filter((t) => blockedReason(t) === null);
const blocked = tasks.filter((t) => blockedReason(t) !== null && t.state !== 'done');

if (blocked.length) {
  console.log(`${D}not runnable:${X}`);
  for (const t of blocked) console.log(`  ${D}·${X} ${t.iri.split('/').pop()} ${D}— ${blockedReason(t)}${X}`);
  console.log('');
}

// Abandoned work: a claim that lapsed and nobody ever reported an outcome. This is the exact
// failure that already bit us — a scheduler that fired, produced nothing, said nothing, and
// still displayed a future run time. It looked armed while being dead.
const abandoned = tasks.filter((t) => t.state === 'claimed' && t.claimExpires && now >= t.claimExpires && !t.outcome);
for (const t of abandoned) {
  console.log(`${Y}!${X} ${t.iri.split('/').pop()} ${D}— lease lapsed with NO outcome. Its runner died. Requeued.${X}`);
  journal({ event: 'abandoned', task: t.iri, previousRunner: t.claimedBy });
}
if (abandoned.length) console.log('');

if (runnable.length === 0) {
  console.log(`${G}Nothing to run.${X} ${D}${tasks.length} task(s) in the queue.${X}`);
  process.exit(0);
}

let ran = 0;
let failed = 0;

for (const t of runnable) {
  const short = t.iri.split('/').pop();
  console.log(`${B}▶ ${short}${X} ${D}— ${t.goal}${X}`);

  if (DRY) {
    console.log(`  ${D}would run:  ${t.command}${X}`);
    console.log(`  ${D}would verify: ${t.doneWhen}${X}\n`);
    ran++;
    if (ONCE) break;
    continue;
  }

  // 1. CLAIM — a lease, so a second runner cannot take the same task.
  setFacts(t.iri, {
    'claimed-by': RUNNER_ID,
    'claim-expires': String(now + LEASE_MS),
    'task-state': 'claimed',
  });
  journal({ event: 'claimed', task: t.iri });

  // 2. EXECUTE
  let execOk = true;
  let execOut = '';
  let execCode = 0;
  try {
    execOut = execSync(t.command!, { encoding: 'utf8', stdio: 'pipe', shell: '/bin/bash', timeout: 15 * 60 * 1000 });
  } catch (e: any) {
    execOk = false;
    execCode = typeof e?.status === 'number' ? e.status : 1;
    execOut = (e?.stdout ?? '') + (e?.stderr ?? '') || String(e?.message ?? e);
  }

  // THE TASK ASKED, RATHER THAN GUESSED. It is not done and it is not failed — neither would
  // be true, and recording either would be a lie. It is WAITING, and it will come back on its
  // own when the answer lands. Nothing else in the queue is held up by it.
  if (execCode === NEEDS_ANSWER) {
    setFacts(t.iri, {
      'task-state': 'waiting',
      'claim-expires': '0',
      outcome: `WAITING on a human decision. The task asked rather than guessing — a guess ` +
        `silently entered into a knowledge graph is worse than a stalled task. It resumes by itself ` +
        `when the question is answered (review queue, or Shelly — either resolves the same fact).`,
    });
    journal({ event: 'waiting', task: t.iri });
    console.log(`  ${Y}?${X} ${D}asked a question and suspended — it will resume when you answer.${X}\n`);
    ran++;
    if (ONCE) break;
    continue;
  }

  console.log(`  ${execOk ? G + 'ran' : Y + 'command exited non-zero'}${X}`);

  // 3. VERIFY — independently. The command's own opinion of itself is not evidence: a thing
  //    that did the work is the party with an interest in believing it worked.
  let verified = false;
  let verifyOut = '';
  try {
    verifyOut = execSync(t.doneWhen!, { encoding: 'utf8', stdio: 'pipe', shell: '/bin/bash', timeout: 15 * 60 * 1000 });
    verified = true;
  } catch (e: any) {
    verified = false;
    verifyOut = (e?.stdout ?? '') + (e?.stderr ?? '') || String(e?.message ?? e);
  }

  // 4. REPORT — the outcome goes into the graph either way.
  const outcome = verified
    ? `done — verified by: ${t.doneWhen}`
    : `FAILED — the work ran${execOk ? '' : ' (and exited non-zero)'} but the acceptance check did not pass: ${t.doneWhen}. ` +
      `Last output: ${verifyOut.trim().split('\n').slice(-2).join(' / ').slice(0, 200)}`;

  const interval = parseEvery(t.every);
  const facts: Record<string, string> = {
    outcome,
    'claim-expires': '0',
    'last-run': String(now),
  };
  if (interval !== null) {
    // Recurring: it is not finished, it is due again. The next due time is computed from NOW,
    // not from the scheduled time — so a machine that was asleep for a week does not wake up
    // owing seven runs. It owes one. Drain, do not schedule.
    facts['task-state'] = 'open';
    facts['due-at'] = String(now + interval);
  } else {
    facts['task-state'] = verified ? 'done' : 'failed';
  }
  // A failure counts against the attempt budget; a success clears it. Bounded patience.
  facts['attempts'] = String(verified ? 0 : (t.attempts ?? 0) + 1);
  setFacts(t.iri, facts);
  journal({ event: verified ? 'done' : 'failed', task: t.iri, outcome });

  console.log(`  ${verified ? G + '✓ verified' : R + '✗ NOT verified'}${X} ${D}${t.doneWhen}${X}`);
  if (interval !== null) {
    console.log(`  ${D}recurring — due again in ${t.every}${X}`);
  }
  console.log('');

  ran++;
  if (!verified) failed++;
  if (ONCE) break;
}

console.log(
  `${B}══${X} ${ran} task(s) ${DRY ? 'would run' : 'run'}, ${failed ? R + failed + ' failed' + X : G + '0 failed' + X}. ` +
    `${D}Outcomes written to the graph.${X}`,
);

// A failed task is a reported fact, not a crashed runner. The queue keeps moving.
process.exit(0);
