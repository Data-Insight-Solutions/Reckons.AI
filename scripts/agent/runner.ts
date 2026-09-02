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
 *   npx tsx scripts/agent/runner.ts --graph … --allow-effects=queue-write --max-tasks=1
 *   npx tsx scripts/agent/runner.ts --graph … --task=local-code-review --allow-effects=source-write,queue-write
 *   npx tsx scripts/agent/runner.ts --graph … --all --allow-effects=all
 *
 * The default WIP cap is one and the default authority is read-only. `--all` and every effect
 * beyond read-only must be explicit; `--once` remains a readable alias for the default cap.
 */
import { execFileSync, execSync } from 'child_process';
import { readFileSync, existsSync, appendFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import path from 'path';
import { Parser, Writer, DataFactory, type Quad } from 'n3';
import { orderForModelBatching } from '../../src/lib/rdf/agent-task.js';
import { collectMcpContext } from './mcp-context.js';
import { captureGitState, runSucceeded } from './run-contract.js';
import { atomicWriteFile, withFileLock } from './state-file.js';

const { namedNode, literal, quad } = DataFactory;

const KPRED = 'urn:kbase:predicate/';
const KTYPE = 'urn:kbase:type/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const AGENT_TASK = `${KTYPE}AgentTask`;
const JOURNAL = 'reckons-workspace/runner.log.jsonl';
const RECEIPTS_DIR = 'reckons-workspace/runs';
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
const ALL = argv.includes('--all');
const GRAPH = flag('graph');
const TASK_FILTER = flag('task');
const RUNNER_ID = flag('id') ?? `script-runner@${process.pid}`;
const EFFECTS = ['read-only', 'queue-write', 'source-write', 'external-read', 'external-write'] as const;
type Effect = (typeof EFFECTS)[number];
// These describe the TASK COMMAND's authority. The runner's own derived state, journal, and
// receipt writes are mandatory bookkeeping and do not turn a read-only diagnostic into a source
// mutator.
const requestedEffects = new Set((flag('allow-effects') ?? 'read-only').split(',').map((v) => v.trim()).filter(Boolean));
const allowedEffects = requestedEffects.has('all') ? new Set<string>(EFFECTS) : requestedEffects;
const maxTasksRaw = flag('max-tasks');
const MAX_TASKS = ONCE || !ALL ? Number(maxTasksRaw ?? 1) : Number.POSITIVE_INFINITY;
if (!(MAX_TASKS === Number.POSITIVE_INFINITY || (Number.isInteger(MAX_TASKS) && MAX_TASKS >= 1))) {
  console.error(`${R}--max-tasks must be a positive integer.${X}`);
  process.exit(2);
}

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
if (!GRAPH.endsWith('.ttl')) {
  console.error(`${R}The task graph must end in .ttl: ${GRAPH}${X}`);
  console.error(`${D}Refusing to derive state from an ambiguous path; the authored graph must never be a state-file target.${X}`);
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
const STATE = `${GRAPH.slice(0, -'.ttl'.length)}.state.ttl`;
if (path.resolve(STATE) === path.resolve(GRAPH)) {
  console.error(`${R}Refusing to use the authored graph as derived state: ${GRAPH}${X}`);
  process.exit(2);
}

let quads: Quad[];
try {
  quads = new Parser().parse(readFileSync(GRAPH, 'utf8')) as Quad[];
} catch (e) {
  console.error(`${R}The task queue does not parse: ${GRAPH}${X}`);
  console.error(`${D}${e instanceof Error ? e.message : e}${X}`);
  process.exit(2);
}

// CORRUPT STATE FAILS CLOSED. Treating it as empty can re-run a source-writing or external task;
// that is not recovery, it is duplicate side effects. State is derived, but it is still the only
// durable claim/outcome record, so a human must inspect or deliberately remove an unreadable file.
let stateQuads: Quad[] = [];
if (existsSync(STATE)) {
  try {
    stateQuads = new Parser().parse(readFileSync(STATE, 'utf8')) as Quad[];
  } catch (e) {
    console.error(`${R}State file is unreadable; refusing to run: ${STATE}${X}`);
    console.error(`${D}${e instanceof Error ? e.message.split('\n')[0] : e}${X}`);
    process.exit(2);
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
  /** The local model this task loads (e.g. "qwen3-coder", "qwen2.5vl"). Used to BATCH same-model
   *  tasks consecutively — Ollama + RAM cannot switch models cheaply, so reordering to keep one
   *  model warm across its tasks avoids reload thrash. Optional; script tier has none. */
  model?: string;
  /** Recurrence, e.g. "30m", "6h", "7d". A recurring task is never "done" — it is DUE AGAIN. */
  every?: string;
  /** Epoch ms. Not runnable before this. */
  dueAt?: number;
  lastRun?: number;
  /** Consecutive failures. Bounded by MAX_ATTEMPTS. */
  attempts?: number;
  /** Declared effects. The runner gates these before giving graph-authored shell to a process. */
  effects: string[];
  /** A bounded graph query fetched through MCP before a local-agent task runs. */
  contextQuery?: string;
  contextBudget?: number;
  /** Durable subject|predicate keys for a suspended question. Pending rows may be drained. */
  waitingKeys: string[];
}

function parseWaitingKeys(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((key) => typeof key === 'string' && key.length > 0)
      ? [...new Set(parsed)]
      : [];
  } catch {
    return [];
  }
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
  model: one(iri, 'model'),
  every: one(iri, 'every'),
  dueAt: Number(one(iri, 'due-at') ?? 0) || undefined,
  lastRun: Number(one(iri, 'last-run') ?? 0) || undefined,
  attempts: Number(one(iri, 'attempts') ?? 0) || 0,
  effects: many(iri, 'effect'),
  contextQuery: one(iri, 'context-query'),
  contextBudget: Number(one(iri, 'context-budget') ?? 0) || undefined,
  waitingKeys: parseWaitingKeys(one(iri, 'waiting-keys')),
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
  execFileSync('curl', ['-sf', '-m', '3', '-o', '/dev/null', `${OLLAMA.replace(/\/$/, '')}/api/tags`], {
    stdio: 'ignore',
  });
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
interface QuestionRef { key: string; text: string }
const questionKey = (q: any): string | null =>
  typeof q?.subject === 'string' && typeof q?.predicate === 'string'
    ? `${q.subject}|${q.predicate}`
    : null;
const blockTargets = (blocks: unknown): string[] =>
  typeof blocks === 'string'
    ? [blocks]
    : Array.isArray(blocks)
      ? blocks.filter((block): block is string => typeof block === 'string')
      : [];

function pendingQuestionsByTask(): Map<string, QuestionRef[]> {
  const byTask = new Map<string, QuestionRef[]>();
  for (const q of readJsonl(PENDING)) {
    if (q.type !== 'question') continue;
    const key = questionKey(q);
    if (!key || answeredKeys.has(key)) continue;
    for (const blockedTask of blockTargets(q.blocks)) {
      const list = byTask.get(blockedTask) ?? [];
      list.push({ key, text: q.question ?? `${q.subject} ${q.predicate} ?` });
      byTask.set(blockedTask, list);
    }
  }
  return byTask;
}
/** taskIri -> questions still visible in the pending queue. WAITING state below uses persisted
 * keys instead, because importing/draining the pending row must not wake the task by accident. */
const openQuestionsFor = pendingQuestionsByTask();

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
  if (t.effects.length === 0) {
    return 'NO effect declaration — the runner cannot safely choose an authority boundary for this task';
  }
  const unknownEffects = t.effects.filter((effect) => !EFFECTS.includes(effect as Effect));
  if (unknownEffects.length) return `unknown effect declaration: ${unknownEffects.join(', ')}`;
  const disallowedEffects = t.effects.filter((effect) => !allowedEffects.has(effect));
  if (disallowedEffects.length) {
    return `requires effect ${disallowedEffects.join(', ')} — allow explicitly with --allow-effects=${disallowedEffects.join(',')}`;
  }
  if (t.contextQuery !== undefined && !t.contextQuery.trim()) return 'blank MCP context query';
  if (t.contextBudget !== undefined && (!Number.isInteger(t.contextBudget) || t.contextBudget < 200 || t.contextBudget > 8000)) {
    return 'MCP context budget must be an integer from 200 to 8000';
  }
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
  if (t.state === 'waiting') {
    if (t.waitingKeys.length === 0) return 'WAITING with no durable question key — manual inspection required';
    const unanswered = t.waitingKeys.filter((key) => !answeredKeys.has(key));
    if (unanswered.length) return `WAITING on ${unanswered.length} unanswered graph question(s)`;
  }
  // Waiting on a human. Not failed, not done — ASKED. It comes back by itself when answered.
  const asked = openQuestionsFor.get(t.iri) ?? [];
  if (asked.length) return `WAITING on you — ${asked[0].text.slice(0, 90)}`;

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
function currentStateQuads(): Quad[] {
  if (!existsSync(STATE)) return [];
  try {
    return new Parser().parse(readFileSync(STATE, 'utf8')) as Quad[];
  } catch (error) {
    throw new Error(
      `state file became unreadable; refusing a state transition (${STATE}): ` +
      `${error instanceof Error ? error.message.split('\n')[0] : error}`,
    );
  }
}

function stateValue(current: Quad[], iri: string, predicate: string): string | undefined {
  return current.find((q) => q.subject.value === iri && q.predicate.value === `${KPRED}${predicate}`)?.object.value;
}

function writeStateQuads(next: Quad[]): void {
  // N-Triples is a valid Turtle subset and this serializer is synchronous. Do not hold a kernel
  // lock across Writer.end(callback) and hope an implementation detail keeps the callback inline.
  const body = new Writer({ format: 'N-Triples' }).quadsToString(next);
  atomicWriteFile(
    STATE,
    `# GENERATED by scripts/agent/runner.ts — do not hand-edit.\n` +
      `# The authored queue is ${path.basename(GRAPH!)}; this is only the machine's record of\n` +
      `# what it claimed, ran, and what came of it. Delete it to reset the queue.\n\n${body}`,
  );
}

/** Locked read-modify-replace. `expectedClaimToken` fences a late runner whose lease expired and
 * was reclaimed. A token is necessary but not sufficient: an expired owner may not renew or
 * complete even if no replacement has claimed the task yet. */
function setFacts(
  iri: string,
  facts: Record<string, string | null>,
  expectedClaimToken?: string,
): boolean {
  if (DRY) return true;
  return withFileLock(`${STATE}.lock`, () => {
    const current = currentStateQuads();
    if (expectedClaimToken) {
      const liveToken = stateValue(current, iri, 'claim-token');
      const liveExpiry = Number(stateValue(current, iri, 'claim-expires') ?? 0);
      if (liveToken !== expectedClaimToken || !Number.isFinite(liveExpiry) || liveExpiry <= Date.now()) return false;
    }
    const keys = Object.keys(facts);
    const keep = current.filter(
      (q) => !(q.subject.value === iri && keys.some((p) => q.predicate.value === `${KPRED}${p}`)),
    );
    for (const [p, v] of Object.entries(facts)) {
      if (v !== null) keep.push(quad(namedNode(iri), namedNode(`${KPRED}${p}`), literal(v)) as Quad);
    }
    writeStateQuads(keep);
    return true;
  });
}

function renewClaim(iri: string, claimToken: string): boolean {
  return setFacts(iri, { 'claim-expires': String(Date.now() + LEASE_MS) }, claimToken);
}

interface Claim {
  token: string;
  /** Attempts re-read under the claim lock. The startup task snapshot may be stale. */
  attempts: number;
}

/** Re-check and claim under the same lock. Candidate selection above is advisory only: another
 * runner may have claimed or completed the task since this process read the queue. */
function tryClaim(t: Task): Claim | null {
  if (DRY) return { token: 'dry-run', attempts: t.attempts ?? 0 };
  return withFileLock(`${STATE}.lock`, () => {
    const current = currentStateQuads();
    const liveState = stateValue(current, t.iri, 'task-state') ?? t.state;
    const liveClaimedBy = stateValue(current, t.iri, 'claimed-by');
    const liveExpiry = Number(stateValue(current, t.iri, 'claim-expires') ?? 0);
    const liveDue = Number(stateValue(current, t.iri, 'due-at') ?? t.dueAt ?? 0);
    const parsedAttempts = Number(stateValue(current, t.iri, 'attempts') ?? t.attempts ?? 0);
    const liveAttempts = Number.isInteger(parsedAttempts) && parsedAttempts >= 0 ? parsedAttempts : 0;
    const currentTime = Date.now();
    if (liveState === 'done' && parseEvery(t.every) === null) return null;
    if (liveDue > currentTime || liveAttempts >= MAX_ATTEMPTS) return null;
    if (liveClaimedBy && liveExpiry > currentTime) return null;
    if (liveState === 'waiting') {
      const liveWaitingKeys = parseWaitingKeys(stateValue(current, t.iri, 'waiting-keys'));
      if (liveWaitingKeys.length === 0 || liveWaitingKeys.some((key) => !answeredKeys.has(key))) return null;
    }

    const token = randomUUID();
    const facts: Record<string, string> = {
      'claimed-by': RUNNER_ID,
      'claim-token': token,
      'claim-expires': String(currentTime + LEASE_MS),
      'task-state': 'claimed',
    };
    // Clear the prior waiting/outcome record when its answer allows a fresh attempt. Otherwise a
    // runner that dies after reclaim would still look like a completed WAITING run.
    const keys = [...Object.keys(facts), 'waiting-keys', 'outcome'];
    const keep = current.filter(
      (q) => !(q.subject.value === t.iri && keys.some((p) => q.predicate.value === `${KPRED}${p}`)),
    );
    for (const [p, v] of Object.entries(facts)) {
      keep.push(quad(namedNode(t.iri), namedNode(`${KPRED}${p}`), literal(v)) as Quad);
    }
    writeStateQuads(keep);
    return { token, attempts: liveAttempts };
  });
}

function journal(entry: object) {
  try {
    appendFileSync(JOURNAL, JSON.stringify({ at: new Date().toISOString(), runner: RUNNER_ID, ...entry }) + '\n');
  } catch {
    /* the journal is a convenience; the graph is the record */
  }
}

/** A durable, structured account of the run. State says what the queue believes; a receipt
 * says what was actually invoked, against which checkout, and what each independent command
 * returned. Output is hashed rather than copied: tool output can contain noisy or sensitive
 * material and a receipt must be safe to leave in the workspace. */
function writeReceipt(input: {
  task: Task;
  claimToken: string;
  startedAt: number;
  finishedAt: number;
  commandExit: number;
  commandOutput: string;
  verificationExit?: number;
  verificationOutput?: string;
  context?: { query: string; budget: number; path: string; contentSha256: string };
}): string | undefined {
  if (DRY) return undefined;
  const short = input.task.iri.split('/').pop()?.replace(/[^a-zA-Z0-9_.-]/g, '-') ?? 'task';
  const stamp = new Date(input.finishedAt).toISOString().replace(/[:.]/g, '-');
  const receiptPath = path.join(RECEIPTS_DIR, `${short}-${input.claimToken}-${stamp}.json`);
  try {
    const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
    const git = captureGitState();
    if (!git.available) throw new Error(`could not fingerprint git state: ${git.error}`);
    atomicWriteFile(receiptPath, JSON.stringify({
      schema: 'reckons.task-run-receipt/v1',
      task: input.task.iri,
      runner: RUNNER_ID,
      claimToken: input.claimToken,
      startedAt: new Date(input.startedAt).toISOString(),
      finishedAt: new Date(input.finishedAt).toISOString(),
      durationMs: input.finishedAt - input.startedAt,
      effects: input.task.effects,
      command: input.task.command,
      commandExit: input.commandExit,
      commandOutputSha256: sha256(input.commandOutput),
      doneWhen: input.task.doneWhen,
      verificationExit: input.verificationExit,
      verificationOutputSha256: input.verificationOutput === undefined ? undefined : sha256(input.verificationOutput),
      mcpContext: input.context,
      git,
    }, null, 2) + '\n');
    return receiptPath;
  } catch (e) {
    console.log(`${Y}!${X} could not write receipt — ${D}${e instanceof Error ? e.message : e}${X}`);
    return undefined;
  }
}

// ── Drain ──────────────────────────────────────────────────────────────────
console.log(
  `${B}Runner${X} ${D}— ${GRAPH} · ${RUNNER_ID}${DRY ? ' · DRY RUN' : ''} · ` +
  `WIP ${Number.isFinite(MAX_TASKS) ? MAX_TASKS : 'all'} · allowed effects: ${[...allowedEffects].join(', ') || 'none'}${X}\n`,
);

// Batch by local model so Ollama keeps one model warm across its tasks instead of thrashing
// reloads between them (RAM cannot switch models cheaply). Script tier stays first (free).
const runnable = orderForModelBatching(tasks.filter((t) => blockedReason(t) === null));
const blocked = tasks.filter((t) => blockedReason(t) !== null && t.state !== 'done');
const matchesTask = (t: Task) => !TASK_FILTER || t.iri === TASK_FILTER || t.iri.endsWith(`/${TASK_FILTER}`);
const selectedRunnable = runnable.filter(matchesTask);

if (TASK_FILTER && !tasks.some(matchesTask)) {
  console.error(`${R}No task matches --task=${TASK_FILTER}.${X}`);
  process.exit(2);
}

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

if (selectedRunnable.length === 0) {
  console.log(`${G}Nothing to run.${X} ${D}${tasks.length} task(s) in the queue.${X}`);
  process.exit(0);
}

let ran = 0;
let failed = 0;
let warmModel: string | undefined; // the model currently kept warm, for batch-boundary logging

for (const t of selectedRunnable) {
  const short = t.iri.split('/').pop();
  // Announce a model batch boundary — the whole point of the ordering is that this fires as few
  // times as possible, because each firing is a real Ollama reload.
  if (t.model && t.model !== warmModel) {
    console.log(`${D}◆ loading model ${t.model} — kept warm for its batch${X}`);
    warmModel = t.model;
  }
  console.log(`${B}▶ ${short}${X} ${D}— ${t.goal}${X}`);

  if (DRY) {
    console.log(`  ${D}would run:  ${t.command}${X}`);
    console.log(`  ${D}would verify: ${t.doneWhen}${X}\n`);
    console.log(`  ${D}effects: ${t.effects.join(', ')}${X}\n`);
    if (t.contextQuery) console.log(`  ${D}would query MCP kb_compress (${t.contextBudget ?? 1400} tok): ${t.contextQuery}${X}\n`);
    ran++;
    if (ran >= MAX_TASKS) break;
    continue;
  }

  // 1. CLAIM — atomically re-check and lease. The runnable list is a snapshot; only this
  // transaction decides who owns the work.
  let claim: Claim | null;
  try {
    claim = tryClaim(t);
  } catch (error) {
    console.error(`${R}Could not safely claim ${t.iri}: ${error instanceof Error ? error.message : error}${X}`);
    process.exit(2);
  }
  if (!claim) {
    console.log(`  ${D}lost race or no longer runnable — another runner/state change got there first.${X}\n`);
    journal({ event: 'claim-skipped', task: t.iri });
    continue;
  }
  const claimToken = claim.token;
  journal({ event: 'claimed', task: t.iri, claimToken });

  // 2. EXECUTE
  let execOk = true;
  let execOut = '';
  let execCode = 0;
  const startedAt = Date.now();
  const taskEpoch = Math.floor(startedAt / 1000) - 1;
  let context: { query: string; budget: number; path: string; contentSha256: string } | undefined;
  if (t.contextQuery) {
    const short = t.iri.split('/').pop()?.replace(/[^a-zA-Z0-9_.-]/g, '-') ?? 'task';
    const contextPath = path.join(RECEIPTS_DIR, `${short}-${claimToken}-context-${startedAt}.json`);
    try {
      const fetched = collectMcpContext(t.contextQuery, t.contextBudget ?? 1400);
      atomicWriteFile(contextPath, JSON.stringify(fetched, null, 2) + '\n');
      context = { query: fetched.query, budget: fetched.budget, path: contextPath, contentSha256: fetched.contentSha256 };
      console.log(`  ${D}MCP context: kb_compress (${fetched.content.length} chars)${X}`);
    } catch (error) {
      execOk = false;
      execCode = 1;
      execOut = `MCP context failed — ${error instanceof Error ? error.message : error}`;
    }
  }
  if (execOk) {
    try {
    // Pass the SAME Ollama URL the runner just up-checked (line ~231) into the child. Without
    // this the runner and the child disagree on the default: the runner falls back to
    // localhost:11434 and sees Ollama up, runs the task — but a child that falls back to '' (as
    // code-review.ts did) hard-exits "OLLAMA_BASE_URL not set" even though Ollama is running.
    // The runner is the source of truth for the URL it verified; the child inherits it.
    const childEnv = {
      ...process.env, OLLAMA_BASE_URL: OLLAMA, TASK_RUN_EPOCH: String(taskEpoch),
      TASK_MCP_CONTEXT: context?.path ?? '',
    };
    execOut = execSync(t.command!, { encoding: 'utf8', stdio: 'pipe', shell: '/bin/bash', timeout: 15 * 60 * 1000, env: childEnv });
    } catch (e: any) {
      execOk = false;
      execCode = typeof e?.status === 'number' ? e.status : 1;
      execOut = (e?.stdout ?? '') + (e?.stderr ?? '') || String(e?.message ?? e);
    }
  }

  // THE TASK ASKED, RATHER THAN GUESSED. It is not done and it is not failed — neither would
  // be true, and recording either would be a lie. It is WAITING, and it will come back on its
  // own when the answer lands. Nothing else in the queue is held up by it.
  if (execCode === NEEDS_ANSWER) {
    const waitingQuestions = pendingQuestionsByTask().get(t.iri) ?? [];
    const waitingKeys = [...new Set(waitingQuestions.map((question) => question.key))];
    const finishedAt = Date.now();
    const receipt = writeReceipt({
      task: t, claimToken, startedAt, finishedAt, commandExit: execCode, commandOutput: execOut, context,
    });
    const waitingFacts: Record<string, string | null> = {
      'task-state': 'waiting',
      'claim-expires': '0',
      'claim-token': null,
      'claimed-by': null,
      'waiting-keys': JSON.stringify(waitingKeys),
      outcome: `WAITING on a human decision. The task asked rather than guessing — a guess ` +
        `silently entered into a knowledge graph is worse than a stalled task. It resumes by itself ` +
        `when the question is answered (review queue, or Shelly — either resolves the same fact).`,
    };
    if (!receipt || waitingKeys.length === 0) {
      waitingFacts['task-state'] = 'failed';
      waitingFacts['waiting-keys'] = null;
      waitingFacts['last-receipt'] = null;
      waitingFacts.attempts = String(claim.attempts + 1);
      waitingFacts.outcome = !receipt
        ? 'FAILED — the task asked a question but no durable receipt was written.'
        : 'FAILED — exit 42 did not leave a durable subject|predicate question key for this task.';
    } else {
      waitingFacts['last-receipt'] = receipt;
    }
    const retained = setFacts(t.iri, waitingFacts, claimToken);
    if (!retained) {
      journal({ event: 'stale-completion-discarded', task: t.iri, phase: 'waiting', claimToken, receipt });
      console.log(`  ${R}✗ claim was lost before WAITING state could be retained; result discarded.${X}\n`);
      failed++;
    } else if (!receipt || waitingKeys.length === 0) {
      journal({ event: 'failed', task: t.iri, claimToken, outcome: waitingFacts.outcome, receipt });
      console.log(`  ${R}✗ ${waitingFacts.outcome}${X}\n`);
      failed++;
    } else {
      journal({ event: 'waiting', task: t.iri, claimToken, waitingKeys, receipt });
      console.log(`  ${Y}?${X} ${D}asked a question and suspended — it will resume when you answer.${X}\n`);
    }
    ran++;
    if (ran >= MAX_TASKS) break;
    continue;
  }

  console.log(`  ${execOk ? G + 'ran' : Y + 'command exited non-zero'}${X}`);

  // Refresh before the independent check. A late owner is fenced out rather than overwriting a
  // task that was reclaimed after its lease expired.
  if (!renewClaim(t.iri, claimToken)) {
    const receipt = writeReceipt({
      task: t, claimToken, startedAt, finishedAt: Date.now(), commandExit: execCode, commandOutput: execOut, context,
    });
    journal({ event: 'stale-completion-discarded', task: t.iri, phase: 'before-verification', claimToken, receipt });
    console.log(`  ${R}✗ claim was lost before verification; result discarded.${X}\n`);
    ran++;
    failed++;
    if (ran >= MAX_TASKS) break;
    continue;
  }

  // 3. VERIFY — independently. The command's own opinion of itself is not evidence: a thing
  //    that did the work is the party with an interest in believing it worked.
  let verified = false;
  let verifyCode = 1;
  let verifyOut = '';
  try {
    verifyOut = execSync(t.doneWhen!, {
      encoding: 'utf8', stdio: 'pipe', shell: '/bin/bash', timeout: 15 * 60 * 1000,
      env: { ...process.env, OLLAMA_BASE_URL: OLLAMA, TASK_RUN_EPOCH: String(taskEpoch), TASK_MCP_CONTEXT: context?.path ?? '' },
    });
    verified = true;
    verifyCode = 0;
  } catch (e: any) {
    verified = false;
    verifyCode = typeof e?.status === 'number' ? e.status : 1;
    verifyOut = (e?.stdout ?? '') + (e?.stderr ?? '') || String(e?.message ?? e);
  }

  // 4. REPORT — the outcome goes into the graph either way.
  let succeeded = runSucceeded(execCode, verifyCode);
  let outcome = succeeded
    ? `done — command exited 0 and independently verified by: ${t.doneWhen}`
    : !execOk
      ? `FAILED — command exited ${execCode}; the acceptance check ${verified ? 'passed, but cannot erase an execution failure' : `also failed (${verifyCode})`}. ` +
        `Last command output: ${execOut.trim().split('\n').slice(-2).join(' / ').slice(0, 200)}`
      : `FAILED — command exited 0 but the acceptance check failed (${verifyCode}): ${t.doneWhen}. ` +
        `Last verification output: ${verifyOut.trim().split('\n').slice(-2).join(' / ').slice(0, 200)}`;

  const interval = parseEvery(t.every);
  const finishedAt = Date.now();
  const facts: Record<string, string | null> = {
    outcome,
    'claim-expires': '0',
    'last-run': String(finishedAt),
    'claim-token': null,
    'claimed-by': null,
    'waiting-keys': null,
  };
  const receipt = writeReceipt({
    task: t, claimToken, startedAt, finishedAt, commandExit: execCode, commandOutput: execOut,
    verificationExit: verifyCode, verificationOutput: verifyOut, context,
  });
  if (receipt) {
    facts['last-receipt'] = receipt;
  } else {
    succeeded = false;
    outcome = `FAILED — no durable receipt was written, so this run cannot bind its command, verification, MCP context, and checkout.`;
    facts.outcome = outcome;
    facts['last-receipt'] = null;
  }
  if (interval !== null) {
    // Recurring: it is not finished, it is due again. The next due time is computed from NOW,
    // not from the scheduled time — so a machine that was asleep for a week does not wake up
    // owing seven runs. It owes one. Drain, do not schedule.
    facts['task-state'] = 'open';
    facts['due-at'] = String(finishedAt + interval);
  } else {
    facts['task-state'] = succeeded ? 'done' : 'failed';
  }
  // A failure counts against the attempt budget; a success clears it. Bounded patience.
  facts['attempts'] = String(succeeded ? 0 : claim.attempts + 1);
  const retained = setFacts(t.iri, facts, claimToken);
  if (!retained) {
    succeeded = false;
    outcome = 'FAILED — claim ownership changed before completion; stale result was discarded.';
    journal({ event: 'stale-completion-discarded', task: t.iri, phase: 'final', claimToken, receipt });
    console.log(`  ${R}✗ claim was lost before final state could be retained; result discarded.${X}\n`);
    ran++;
    failed++;
    if (ran >= MAX_TASKS) break;
    continue;
  }
  journal({ event: succeeded ? 'done' : 'failed', task: t.iri, claimToken, outcome, receipt });

  console.log(`  ${succeeded ? G + '✓ verified' : R + '✗ FAILED'}${X} ${D}${t.doneWhen}${X}`);
  if (interval !== null) {
    console.log(`  ${D}recurring — due again in ${t.every}${X}`);
  }
  console.log('');

  ran++;
  if (!succeeded) failed++;
  if (ran >= MAX_TASKS) break;
}

console.log(
  `${B}══${X} ${ran} task(s) ${DRY ? 'would run' : 'run'}, ${failed ? R + failed + ' failed' + X : G + '0 failed' + X}. ` +
    `${D}${DRY ? 'No commands or state were changed.' : 'State and receipts recorded.'}${X}`,
);

// A failed task is a reported fact, not a crashed runner. The queue keeps moving.
process.exit(0);
