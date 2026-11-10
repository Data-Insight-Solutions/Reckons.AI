/**
 * LANES (F89.4.3) — what a verdict on a queue row would DO.
 *
 *   claim     subject, predicate and object; accepting it writes a fact.
 *   question  the object is open; the verdict is an answer.
 *   finding   a machine's observation about a file, page or commit that asks for an ACTION.
 *             Accepting it writes nothing, so it can only be rejected or deferred, never settled.
 *
 * Matt decided on 2026-11-10 that findings LEAVE Review: a check's findings are its report (with a
 * ratchet), and only the one question per group that needs his intent reaches a person. This module
 * is the router. It is pure so the MCP tools, the CLI (which shares it by symlink) and the app can
 * use one rule.
 *
 * ORDER OF EVIDENCE: (1) the row's own `lane` field, once F89.4.1 stamps it; (2) the lane its job
 * declares in static/reckons-jobs.ttl (`kpred:emits`), looked up by the row's agent; (3) a
 * first-pass rule for legacy rows that carry neither. The rule is a GUESS and is labelled as such:
 * an object means claim; no object and a `urn:sweep:pred/` predicate (the offline checks' own
 * namespace) or a drift/observation type means finding; any other open row is a question.
 */

export type Lane = 'claim' | 'question' | 'finding';
export const LANES: readonly Lane[] = ['claim', 'question', 'finding'];

export interface LaneRow {
  subject?: string;
  predicate?: string;
  object?: string;
  type?: string;
  agent?: string;
  lane?: string;
}

export const isLane = (v: unknown): v is Lane => typeof v === 'string' && (LANES as readonly string[]).includes(v);

/** `offline:dead-weight` and `dead-weight` both name the job `dead-weight`. */
export function jobNameOf(agent: string | undefined): string {
  return String(agent ?? '').trim().replace(/^(offline|script|job):/i, '');
}

export function laneOf(row: LaneRow, jobLanes?: ReadonlyMap<string, Lane>): Lane {
  if (isLane(row.lane)) return row.lane;
  const declared = jobLanes?.get(jobNameOf(row.agent));
  const object = String(row.object ?? '').trim();
  const open = object === '' || object === '?';
  // A job that declares claims or questions still emits rows of the other kind in the old format;
  // the shape of the row (object present or not) wins over a declaration it contradicts.
  if (!open) return 'claim';
  // The offline checks' own namespace marks the old per-file rows, which are findings even for a job
  // that has since moved to asking one question per group (dead-weight, F89.4.3).
  if (String(row.predicate ?? '').startsWith('urn:sweep:pred/')) return 'finding';
  if (declared === 'finding' || declared === 'question') return declared;
  if (/^(drift-warning|observation)$/.test(String(row.type ?? ''))) return 'finding';
  return 'question';
}

export interface LaneSplit<T> { review: T[]; findings: T[] }

/** Rows a person reviews, and the findings that go to a report instead. */
export function routeLanes<T extends LaneRow>(rows: T[], jobLanes?: ReadonlyMap<string, Lane>): LaneSplit<T> {
  const review: T[] = [];
  const findings: T[] = [];
  for (const r of rows) (laneOf(r, jobLanes) === 'finding' ? findings : review).push(r);
  return { review, findings };
}

export function countByLane(rows: LaneRow[], jobLanes?: ReadonlyMap<string, Lane>): Record<Lane, number> {
  const n: Record<Lane, number> = { claim: 0, question: 0, finding: 0 };
  for (const r of rows) n[laneOf(r, jobLanes)]++;
  return n;
}
