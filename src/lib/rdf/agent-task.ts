/**
 * A task is a triple (F87 phase 1 / kb:orch-task-vocab).
 *
 * The queue is the contract and the runner is pluggable — so the queue must live in the
 * GRAPH, not in a YAML file, not in an agent's context window, and not in a chat scrollback.
 * An agent's context is not a database: the moment Claude Code hits a usage limit, anything
 * held only in its head is gone, and the task it was doing becomes "in progress" forever.
 *
 * Put the task in the graph and the failure modes get much duller. A dead runner drops its
 * lease and someone else picks the task up. A woken orchestrator can see what is already
 * claimed. A human can read the queue without an agent to interpret it.
 *
 * The vocabulary, and why each field is load-bearing:
 *
 *   goal        what to do, in words a harness can act on
 *   tier        script | local-agent | frontier — route to the CHEAPEST competent harness
 *   harness     a PREFERENCE, not a requirement ('any' is the default and usually right)
 *   done-when   how a MACHINE will know it worked. Without this a task is a wish, and its
 *               completion is an agent's opinion of its own work — an unverifiable claim,
 *               made by the party it benefits.
 *   blocked-by  a question, a partial fact, or another task. Nothing may start behind it.
 *   claimed-by  a LEASE, not a lock: a runner that dies must not hold a task forever.
 *   outcome     written back on completion — INCLUDING "I did nothing, and here is why".
 *               A green log that is always green is not a record.
 */
import type { Statement } from './types';

export type Tier = 'script' | 'local-agent' | 'frontier';
export type TaskState = 'open' | 'claimed' | 'done' | 'failed';

/** How long a claim survives without a heartbeat. A dead runner must give the task back. */
export const DEFAULT_LEASE_MS = 30 * 60 * 1000; // 30 minutes

export interface AgentTask {
  iri: string;
  goal: string;
  tier: Tier;
  /** Preferred harness ('any' = whatever is cheapest and competent). */
  harness: string;
  /** Machine-checkable acceptance criterion. A task without one must never be assigned. */
  doneWhen?: string;
  /** IRIs of questions/partial-facts/tasks that must resolve first. */
  blockedBy: string[];
  /** Epoch ms. A task is not runnable before this. */
  dueAt?: number;
  /** Who holds the lease, and until when. */
  claimedBy?: string;
  claimExpires?: number;
  state: TaskState;
  /** What happened. Present on done/failed — including "nothing, because…". */
  outcome?: string;
}

const KPRED = 'urn:kbase:predicate/';
const KTYPE = 'urn:kbase:type/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export const AGENT_TASK_TYPE = `${KTYPE}AgentTask`;

const TIERS: Tier[] = ['script', 'local-agent', 'frontier'];
const isTier = (v: string): v is Tier => (TIERS as string[]).includes(v);

/** Read the task queue out of the graph. */
export function parseTasks(statements: Statement[]): AgentTask[] {
  const subjects = new Set(
    statements
      .filter((s) => s.p.value === RDF_TYPE && s.o.value === AGENT_TASK_TYPE)
      .map((s) => s.s.value),
  );

  const tasks: AgentTask[] = [];
  for (const iri of subjects) {
    const own = statements.filter((s) => s.s.value === iri);
    const one = (pred: string): string | undefined =>
      own.find((s) => s.p.value === `${KPRED}${pred}`)?.o.value;
    const many = (pred: string): string[] =>
      own.filter((s) => s.p.value === `${KPRED}${pred}`).map((s) => s.o.value);

    const tierRaw = one('tier') ?? 'frontier';
    const num = (v?: string) => (v && /^\d+$/.test(v) ? Number(v) : undefined);

    tasks.push({
      iri,
      goal: one('goal') ?? '',
      tier: isTier(tierRaw) ? tierRaw : 'frontier',
      harness: one('harness') ?? 'any',
      doneWhen: one('done-when'),
      blockedBy: many('blocked-by'),
      dueAt: num(one('due-at')),
      claimedBy: one('claimed-by'),
      claimExpires: num(one('claim-expires')),
      state: (one('task-state') as TaskState) ?? 'open',
      outcome: one('outcome'),
    });
  }
  return tasks;
}

/**
 * Why a task cannot be assigned right now. Returns null when it can.
 *
 * The refusal to assign a task with no `done-when` is deliberate and is the most important
 * rule here. "Review the results" is unbounded unless the task said, before it started, what
 * would count as success — and an agent left to decide whether its own work is finished will
 * decide that it is.
 */
export function blockedReason(
  task: AgentTask,
  opts: { now: number; resolved: (iri: string) => boolean },
): string | null {
  if (task.state === 'done') return 'already done';
  if (!task.goal.trim()) return 'no goal — there is nothing to do';
  if (!task.doneWhen?.trim()) {
    return 'no done-when — a task without a machine-checkable acceptance criterion is a wish, not a task';
  }
  if (task.dueAt !== undefined && opts.now < task.dueAt) return 'not due yet';

  const unresolved = task.blockedBy.filter((b) => !opts.resolved(b));
  if (unresolved.length > 0) {
    return `blocked by ${unresolved.length} unresolved: ${unresolved.slice(0, 3).join(', ')}`;
  }

  // A live claim held by someone else. An EXPIRED claim is not a blocker — that is the whole
  // point of a lease: the runner died, and the work must not die with it.
  if (task.claimedBy && task.claimExpires !== undefined && opts.now < task.claimExpires) {
    return `claimed by ${task.claimedBy}`;
  }
  return null;
}

/** Tasks a runner may take right now, cheapest tier first. */
export function runnableTasks(
  tasks: AgentTask[],
  opts: { now: number; resolved: (iri: string) => boolean },
): AgentTask[] {
  const order: Record<Tier, number> = { script: 0, 'local-agent': 1, frontier: 2 };
  return tasks
    .filter((t) => blockedReason(t, opts) === null)
    .sort((a, b) => order[a.tier] - order[b.tier]);
}

/**
 * Tasks whose runner has died — the lease lapsed and nobody reported an outcome.
 *
 * This is the check that makes silence visible. The cloud cron fired exactly on schedule,
 * produced nothing, reported nothing, and still displayed a future run time: it LOOKED armed
 * while being dead. A lapsed lease with no outcome is that same failure, and it is now a
 * queryable fact rather than a rumour.
 */
export function abandonedTasks(tasks: AgentTask[], now: number): AgentTask[] {
  return tasks.filter(
    (t) =>
      t.state === 'claimed' &&
      t.claimExpires !== undefined &&
      now >= t.claimExpires &&
      !t.outcome,
  );
}

/** The triples that claim a task. A lease, not a lock. */
export function claimTriples(
  taskIri: string,
  runner: string,
  now: number,
  leaseMs = DEFAULT_LEASE_MS,
): { subject: string; predicate: string; object: string }[] {
  return [
    { subject: taskIri, predicate: `${KPRED}claimed-by`, object: runner },
    { subject: taskIri, predicate: `${KPRED}claim-expires`, object: String(now + leaseMs) },
    { subject: taskIri, predicate: `${KPRED}task-state`, object: 'claimed' },
  ];
}

/**
 * The triples that close a task.
 *
 * `outcome` is REQUIRED, and "nothing happened" is a legitimate — indeed the most important —
 * outcome to record. Silence must never look like success.
 */
export function completeTriples(
  taskIri: string,
  outcome: string,
  ok: boolean,
): { subject: string; predicate: string; object: string }[] {
  if (!outcome.trim()) {
    throw new Error(
      'A task cannot be closed without an outcome. "I did nothing, and here is why" is an ' +
        'outcome; silence is not.',
    );
  }
  return [
    { subject: taskIri, predicate: `${KPRED}outcome`, object: outcome },
    { subject: taskIri, predicate: `${KPRED}task-state`, object: ok ? 'done' : 'failed' },
  ];
}
