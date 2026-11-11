/**
 * F89.4.4 — a run is a set: the group is a node, with run, then subject, then predicate inside it.
 *
 * PURE ON PURPOSE. It takes already-read pending rows and returns a tree; it reads no file,
 * writes nothing, and wires nothing. That is the point the entity makes — "one pure module
 * builds the tree for the app, the MCP tools and the CLI" — one definition of the group, three
 * callers, no caller re-deriving membership.
 *
 * WHAT A RUN IS HERE IS EXACTLY WHAT THE ENTITY RECORDS. A run the job wrote (`run`, else
 * `runId`) is that run, and its group is `runRecorded: true`. A row that carries neither is
 * NOT given a run: the entity's honest-note says 474 of the 1,934 rows queued on 2026-11-10
 * carry no time at all and "this phase does not invent a run for an old row". Such a row is
 * grouped under its producer and the UTC day of its `addedAt` (or under its producer alone,
 * with an empty day, when it has no day either), and the group is flagged
 * `runRecorded: false` — the "run not recorded" label, not a run with a missing name.
 *
 * SUBJECT, THEN PREDICATE, are selectors over the group's rows, per the entity's description
 * ("those two levels are selectors over the run's members, not nodes of their own"). Each
 * level carries its count and the row ids (review-session.ts `rowId`) so a card, a tool or a
 * canvas spotlight can act on exactly that level. The invariant at every level: `count` equals
 * `rowIds.length`, and the children's counts sum to the parent's.
 */

import type { PendingRow } from './review-links.js';
import { rowId } from './review-session.js';

/** Predicate level of the tree: the predicate, how many rows, and which rows. */
export interface RunPredicateGroup {
  predicate: string;
  count: number;
  /** The `rowId` of every row under this predicate, in queue order. */
  rowIds: string[];
}

/** Subject level: the subject, its rows, and the predicates inside it. */
export interface RunSubjectGroup {
  subject: string;
  count: number;
  rowIds: string[];
  predicates: RunPredicateGroup[];
}

/** The group itself — the run-as-set node: space, producer, run, and the tree inside. */
export interface RunGroup {
  /** The space (kb) the rows name; '' when they name none. */
  kb: string;
  /** The producer the rows signed; '(unattributed)' when they signed none. */
  agent: string;
  /** The recorded run id — or, unrecorded groups only, the UTC day of `addedAt`, or '' if there is none. */
  run: string;
  /** False for groups derived from producer and day because the rows carry no run. */
  runRecorded: boolean;
  count: number;
  rowIds: string[];
  subjects: RunSubjectGroup[];
}

const NO_SUBJECT = '(no subject)';
const NO_PREDICATE = '(no predicate)';
const UNATTRIBUTED = '(unattributed)';

/**
 * Group the rows into run-sets and build the tree.
 *
 * Larger groups first; ties in a stable order — kb, then agent, then run, compared as strings —
 * so the same rows in any input order give the same tree.
 */
export function buildRunTree(rows: readonly PendingRow[]): RunGroup[] {
  const slots = new Map<string, Slot>();
  for (const row of rows) {
    const slot = slotFor(row);
    const existing = slots.get(slot.key);
    if (existing) {
      existing.rows.push(row);
      // A recorded group is keyed without its agent, so a second row may sign it: keep the first
      // real signature rather than the placeholder.
      if (existing.agent === UNATTRIBUTED && slot.agent !== UNATTRIBUTED) existing.agent = slot.agent;
    } else {
      slots.set(slot.key, { ...slot, rows: [row] });
    }
  }
  return [...slots.values()].map(toGroup).sort(groupOrder);
}

interface Slot {
  key: string;
  kb: string;
  agent: string;
  run: string;
  runRecorded: boolean;
  rows: PendingRow[];
}

function slotFor(row: PendingRow): Omit<Slot, 'rows'> {
  const kb = (row.kb ?? '').trim();
  const agent = (row.agent ?? '').trim() || UNATTRIBUTED;
  const explicit = (row.run ?? row.runId ?? '').trim();
  if (explicit) {
    // Grouped by space and run; the recorded run and its day are different things, so the flag
    // is part of the key rather than derived from the label.
    return { key: JSON.stringify(['recorded', kb, explicit]), kb, agent, run: explicit, runRecorded: true };
  }
  const day = row.addedAt ? utcDay(row.addedAt) : '';
  return { key: JSON.stringify(['unrecorded', kb, agent, day]), kb, agent, run: day, runRecorded: false };
}

function toGroup(slot: Slot): RunGroup {
  const bySubject = new Map<string, PendingRow[]>();
  for (const row of slot.rows) {
    const subject = (row.subject ?? '').trim() || NO_SUBJECT;
    const list = bySubject.get(subject);
    if (list) list.push(row);
    else bySubject.set(subject, [row]);
  }
  const subjects: RunSubjectGroup[] = [...bySubject.entries()]
    .map(([subject, list]) => ({
      subject,
      count: list.length,
      rowIds: list.map(rowId),
      predicates: predicateGroups(list),
    }))
    .sort(sizeThenName((s) => s.subject));
  return {
    kb: slot.kb,
    agent: slot.agent,
    run: slot.run,
    runRecorded: slot.runRecorded,
    count: slot.rows.length,
    rowIds: slot.rows.map(rowId),
    subjects,
  };
}

function predicateGroups(rows: PendingRow[]): RunPredicateGroup[] {
  const byPredicate = new Map<string, PendingRow[]>();
  for (const row of rows) {
    const predicate = (row.predicate ?? '').trim() || NO_PREDICATE;
    const list = byPredicate.get(predicate);
    if (list) list.push(row);
    else byPredicate.set(predicate, [row]);
  }
  return [...byPredicate.entries()]
    .map(([predicate, list]) => ({ predicate, count: list.length, rowIds: list.map(rowId) }))
    .sort(sizeThenName((p) => p.predicate));
}

/** Larger first; ties by the level's own name, so the order never depends on input order. */
function sizeThenName<T extends { count: number }>(label: (item: T) => string): (a: T, b: T) => number {
  return (a, b) => b.count - a.count || label(a).localeCompare(label(b));
}

function groupOrder(a: RunGroup, b: RunGroup): number {
  return (
    b.count - a.count
    // The same kb/agent/run label with the flag differing is a recorded run beating an unrecorded
    // day that happens to be spelled the same.
    || Number(b.runRecorded) - Number(a.runRecorded)
    || a.kb.localeCompare(b.kb)
    || a.agent.localeCompare(b.agent)
    || a.run.localeCompare(b.run)
  );
}

/**
 * The UTC day of an addedAt timestamp, so a row written at 23:30 local time lands on its UTC day.
 * Unparseable values fall back to their first ten characters — the same reading review-links.ts
 * makes of a queue row's day.
 */
function utcDay(addedAt: string): string {
  const t = Date.parse(addedAt);
  if (Number.isNaN(t)) return addedAt.slice(0, 10);
  return new Date(t).toISOString().slice(0, 10);
}
