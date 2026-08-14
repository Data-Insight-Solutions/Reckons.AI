/**
 * WHICH NODES GO ON THE TIMELINE, AND WHERE — one rule, shared by the 2D and 3D renderers.
 *
 * THE BUG THIS FIXES (Matt, 2026-07-31: "starter-graph timeline force still looks bad";
 * diagnosed 2026-08-13). In event mode both renderers fell back to a statement's `createdAt`
 * — the INGESTION time — for any node without a date, and placed it as though that were an
 * event. A graph is imported in one batch, so every undated node landed at essentially the
 * same instant. Measured on the shipped graphs: starter-everyday has 12 dated nodes and 165
 * undated (93%), starter-guide has 216 undated and none dated. The timeline was therefore a
 * wall of nodes stacked at import time with a handful of real events squeezed beside it.
 *
 * Worse than the wall: those fake timestamps entered dataMin/dataMax, so the axis spanned
 * "import day → real events" and compressed the genuine dates into a sliver of the screen.
 *
 * THE DECISION (Matt, 2026-08-13, settling the F59 open question): an undated node goes to a
 * labelled UNDATED LANE, not onto the axis. Both renderers already contained the lane —
 * `y = -SPREAD_Y * 0.7` — as unreachable dead code, because the createdAt fallback guaranteed
 * every node received a time and the `else` never ran. This makes the intent that was already
 * written down actually happen.
 *
 * WHY THAT IS THE HONEST ANSWER AND NOT JUST THE TIDY ONE. Placing an undated node at its
 * ingestion time is the graph asserting a date it does not have, and asserting it in the one
 * view whose entire job is to say when things happened. A node with no date has a KNOWN
 * ABSENCE, and showing it as a parked, visibly-undated node reports that absence instead of
 * papering over it (kb:thesis, kb:honest-status).
 *
 * ONE LIST, NOT THREE. The recognised temporal predicates lived in three places — this
 * module now takes the single set from parse-date.ts, which already exists precisely so the
 * timeline and the age sweep cannot disagree about what counts as a date.
 */

import { EVENT_DATE_PREDICATES, parseGraphDate } from './parse-date';
import { termKey, type Statement } from './types';

export type TimelineTimeSource = 'event' | 'ingested';

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/**
 * Map every node that HAS a time to that time. Nodes absent from the map are undated and
 * belong in the lane — the caller must not invent a position for them.
 *
 * `event`    — only a recognised temporal predicate carrying a parseable date counts. The
 *              EARLIEST such date wins, so a thing with a start and an end sits at its start.
 * `ingested` — every node takes its statement's createdAt. This mode is explicitly asking
 *              "when did I learn this", so a fallback is the answer rather than a guess, and
 *              objects are included because a literal's arrival is as datable as a subject's.
 */
export function buildNodeTimes(
  statements: readonly Statement[],
  timeSource: TimelineTimeSource,
): Map<string, number> {
  const nodeTime = new Map<string, number>();

  if (timeSource === 'ingested') {
    for (const st of statements) {
      if (!isActive(st) || !st.createdAt) continue;
      const sk = termKey(st.s);
      const ok = termKey(st.o);
      if (!nodeTime.has(sk)) nodeTime.set(sk, st.createdAt);
      if (!nodeTime.has(ok)) nodeTime.set(ok, st.createdAt);
    }
    return nodeTime;
  }

  for (const st of statements) {
    if (!isActive(st)) continue;
    if (!EVENT_DATE_PREDICATES.has(st.p.value)) continue;
    // One shared parsing rule so a date-only fact lands on the day it names — see parse-date.ts.
    const ts = parseGraphDate(st.o.value);
    if (ts === undefined) continue;
    const key = termKey(st.s);
    const existing = nodeTime.get(key);
    if (existing === undefined || ts < existing) nodeTime.set(key, ts);
  }
  return nodeTime;
}

export type TimelineRange = { dataMin: number; dataMax: number; dataRange: number };

/**
 * The axis extent, computed from DATED nodes only.
 *
 * Returns null when nothing is dated, which is a real state the caller must handle rather
 * than render as a degenerate axis: starter-guide.ttl has 216 nodes and not one date.
 */
export function timelineRange(nodeTime: ReadonlyMap<string, number>): TimelineRange | null {
  if (nodeTime.size === 0) return null;
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const t of nodeTime.values()) {
    if (t < dataMin) dataMin = t;
    if (t > dataMax) dataMax = t;
  }
  return { dataMin, dataMax, dataRange: dataMax - dataMin || 1 };
}

/** How many of `nodeKeys` have no time — the count the undated lane label reports. */
export function undatedCount(
  nodeKeys: readonly string[],
  nodeTime: ReadonlyMap<string, number>,
): number {
  let n = 0;
  for (const k of nodeKeys) if (!nodeTime.has(k)) n++;
  return n;
}
