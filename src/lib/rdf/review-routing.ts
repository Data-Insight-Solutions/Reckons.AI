/**
 * Review routing (F88) — WHO should judge this, and WHAT does it cost to leave it unjudged.
 *
 * The review queue was one undifferentiated list, ordered by arrival. That embeds two
 * assumptions, and both are wrong:
 *
 *   1. THAT THE USER IS THE COMPETENT REVIEWER FOR EVERYTHING. They are not. "Does
 *      src/lib/foo.ts exist" is settled by a script in a millisecond. Asking a human is
 *      not merely wasteful — it teaches them that most of the queue is noise, and then
 *      they click Accept on the one item that mattered.
 *
 *   2. THAT ARRIVAL ORDER IS PRIORITY ORDER. It is not. A question with four things stalled
 *      behind it is not "newer" or "older" than a curiosity — it is a DIFFERENT KIND of
 *      item, and burying it under fifty trivia is how a project quietly stops moving.
 *
 * So: route by GATE (rdf/verifiability.ts), rank by BLAST RADIUS. What the user sees is the
 * short list of things only they can settle, ordered by how much is waiting on each.
 */
import type { Statement } from './types';
import { gateFor, type Gate } from './verifiability';
import { termKey } from './types';

/**
 * How much is stalled behind this fact — TRANSITIVELY.
 *
 * A question that blocks three leaves is not the same as a question that blocks three things
 * which are each blocking three more. Counting only direct `blocks` (as questionsByImpact
 * does) flattens that distinction, and the flattening always favours the shallow item,
 * because shallow items are more numerous.
 *
 * So we walk the chain: if answering A unblocks B, and B is itself a pending fact blocking
 * C and D, then A's blast radius includes C and D. Cycles are possible in a user-authored
 * graph and are simply not re-entered — a cycle means the work is deadlocked, which the
 * count should not paper over by spinning forever.
 */
export function blastRadius(statements: Statement[]): Map<string, number> {
  // subject-key -> the pending statements whose settlement is gated on that subject
  const blockedBy = new Map<string, string[]>();
  const byKey = new Map<string, Statement>();

  for (const st of statements) {
    const key = st.id;
    byKey.set(key, st);
    for (const target of st.blocks ?? []) {
      const list = blockedBy.get(target) ?? [];
      list.push(key);
      blockedBy.set(target, list);
    }
  }

  /** Which statements SIT ON a given entity IRI (so a chain can continue through it). */
  const bySubject = new Map<string, Statement[]>();
  for (const st of statements) {
    const k = termKey(st.s);
    bySubject.set(k, [...(bySubject.get(k) ?? []), st]);
  }

  const memo = new Map<string, number>();

  function reach(stId: string, seen: Set<string>): number {
    if (memo.has(stId)) return memo.get(stId)!;
    if (seen.has(stId)) return 0; // cycle — deadlocked work, do not spin
    seen.add(stId);

    const st = byKey.get(stId);
    const targets = st?.blocks ?? [];
    const reached = new Set<string>();

    for (const target of targets) {
      reached.add(target);
      // Does anything else hang off that target? Follow the chain.
      for (const downstream of bySubject.get(`i:${target}`) ?? bySubject.get(target) ?? []) {
        if (downstream.id === stId) continue;
        const sub = reach(downstream.id, seen);
        // Count the downstream item itself, plus whatever it in turn blocks.
        reached.add(downstream.id);
        if (sub > 0) for (const t of downstream.blocks ?? []) reached.add(t);
      }
    }

    seen.delete(stId);
    const n = reached.size;
    memo.set(stId, n);
    return n;
  }

  const out = new Map<string, number>();
  for (const st of statements) out.set(st.id, reach(st.id, new Set()));
  return out;
}

export interface RoutedItem {
  statement: Statement;
  gate: Gate;
  /** How many things are stalled behind this, transitively. */
  impact: number;
}

export interface RoutedQueue {
  /** A script settles these. They should never have been in the user's queue. */
  machine: RoutedItem[];
  /** A reviewing agent settles these (did the cited passage actually say that?). */
  agent: RoutedItem[];
  /** ONLY the user can settle these — their domain, their decision, their principle. */
  user: RoutedItem[];
}

/**
 * Split the pending queue by who is competent to judge it, each lane ranked by blast radius.
 *
 * `typeOf` resolves a subject IRI to its rdf:type, so authority reservations work (every
 * fact about a Tenet or a Decision is the user's, however checkable it looks).
 */
export function routeQueue(
  statements: Statement[],
  typeOf: (subjectIri: string) => string | undefined = () => undefined,
): RoutedQueue {
  const impacts = blastRadius(statements);
  const out: RoutedQueue = { machine: [], agent: [], user: [] };

  for (const st of statements) {
    const gate = gateFor(st, typeOf(st.s.value));
    out[gate].push({ statement: st, gate, impact: impacts.get(st.id) ?? 0 });
  }

  // Most-blocking first. Ties break toward the OLDER item: a hole nobody has filled in a
  // week is evidence that nobody will fill it by accident.
  const rank = (a: RoutedItem, b: RoutedItem) =>
    b.impact - a.impact || a.statement.createdAt - b.statement.createdAt;
  out.machine.sort(rank);
  out.agent.sort(rank);
  out.user.sort(rank);

  return out;
}

/** What the user is actually being spared — the honest headline for the queue. */
export function routingSummary(q: RoutedQueue): string {
  const total = q.machine.length + q.agent.length + q.user.length;
  if (total === 0) return 'Nothing pending.';
  const spared = q.machine.length + q.agent.length;
  if (spared === 0) return `${q.user.length} to review — all of them yours to decide.`;
  return (
    `${q.user.length} of ${total} need you. ` +
    `${q.machine.length} a script can settle; ${q.agent.length} a reviewing agent can.`
  );
}
