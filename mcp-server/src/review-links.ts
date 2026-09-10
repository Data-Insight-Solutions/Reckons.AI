/**
 * REVIEW LINKS — hand a person a task, not a queue (F195).
 *
 * Matt, 2026-09-09: "send me review links, another mcp feature", following "I want to reduce the
 * force of users into the Reckons.AI review screen."
 *
 * THE PROBLEM IS NOT THAT REVIEW IS HARD. It is that "there are 1,047 pending proposals" is not a
 * task anybody can start. A queue that large is opened once, skimmed, and never opened again —
 * and the proposals that actually needed a decision are buried among hundreds that did not.
 *
 * A LINK IS A TASK BECAUSE IT HAS AN END. "22 provenance verdicts from layer-classify, and here
 * is the URL" is finishable in a sitting, which is the only property that gets it done. This mints
 * those URLs by grouping the queue by the agent that proposed each row, so every group is one
 * job's output and can be judged by one standard.
 *
 * IT ORDERS BY CONSEQUENCE, NOT BY SIZE. A group of 22 high-priority rows that would remove a
 * human from a decision outranks 355 low-priority ones, because the cost of getting the first
 * group wrong is much higher and the cost of deferring the second is nearly zero. The queue's own
 * `priority` field is the signal and it is already written by every job that fills it.
 *
 * IT PROPOSES NOTHING AND CONFIRMS NOTHING. It reads the queue and writes URLs.
 */

import { existsSync, readFileSync } from 'node:fs';

export interface PendingRow {
  subject?: string;
  predicate?: string;
  object?: string;
  note?: string;
  type?: string;
  priority?: string;
  agent?: string;
  addedAt?: string;
}

export interface ReviewGroup {
  agent: string;
  count: number;
  /** Rows marked high priority — the ones whose acceptance changes something structural. */
  high: number;
  /** Most recent addedAt in the group, ISO, or '' when no row carries one. */
  latest: string;
  url: string;
  /** One row's note, trimmed — enough to recognise the group without opening it. */
  sample: string;
}

const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, normal: 2, low: 1 };

/** Read a JSONL queue, skipping unparseable lines rather than failing the whole call. */
export function readPendingRows(file: string): PendingRow[] {
  if (!existsSync(file)) return [];
  const out: PendingRow[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try { out.push(JSON.parse(trimmed) as PendingRow); } catch { /* a torn line is not a reason to report nothing */ }
  }
  return out;
}

/**
 * Group the queue into reviewable slices, each with a link that opens exactly that slice.
 *
 * `base` is the running app — http://localhost:5173 in development, https://reckons.ai in
 * production. The caller supplies it because this module cannot know which one the person asking
 * is actually looking at, and a link to the wrong one is worse than no link.
 */
export function reviewGroups(rows: PendingRow[], base: string): ReviewGroup[] {
  const root = base.replace(/\/+$/, '');
  const byAgent = new Map<string, PendingRow[]>();
  for (const r of rows) {
    const agent = (r.agent ?? '').trim() || '(unattributed)';
    byAgent.set(agent, [...(byAgent.get(agent) ?? []), r]);
  }

  const groups: ReviewGroup[] = [];
  for (const [agent, list] of byAgent) {
    const high = list.filter((r) => (r.priority ?? '').toLowerCase() === 'high').length;
    const latest = list.reduce((acc, r) => (r.addedAt && r.addedAt > acc ? r.addedAt : acc), '');
    const sample = (list.find((r) => r.note)?.note ?? '').replace(/\s+/g, ' ').slice(0, 110);
    /*
     * An unattributed group cannot be linked to — the review page filters on the agent that
     * proposed a row, and there is nothing to filter by. Link to the tab instead, and let the
     * count say how many rows are unreachable that way rather than pretending otherwise.
     */
    const url = agent === '(unattributed)'
      ? `${root}/review?tab=incoming`
      : `${root}/review?tab=incoming&agent=${encodeURIComponent(agent)}`;
    groups.push({ agent, count: list.length, high, latest, url, sample });
  }

  return groups.sort((a, b) => {
    const ap = a.high > 0 ? 1 : 0, bp = b.high > 0 ? 1 : 0;
    return bp - ap || b.high - a.high || b.count - a.count || a.agent.localeCompare(b.agent);
  });
}

/** Render the groups for a tool response — highest consequence first. */
export function renderReviewLinks(groups: ReviewGroup[], total: number): string {
  if (groups.length === 0) return 'The review queue is empty — nothing is waiting on a person.';

  const lines: string[] = [
    `${total} pending proposal(s) in ${groups.length} group(s), highest consequence first.`,
    '',
  ];
  for (const g of groups) {
    const flag = g.high > 0 ? `  ${g.high} HIGH` : '';
    lines.push(`${g.agent} — ${g.count} row(s)${flag}${g.latest ? `  last ${g.latest.slice(0, 10)}` : ''}`);
    lines.push(`  ${g.url}`);
    if (g.sample) lines.push(`  e.g. ${g.sample}${g.sample.length >= 110 ? '…' : ''}`);
    lines.push('');
  }
  lines.push('A link opens the queue filtered to that agent, and the filter is visible in the app');
  lines.push('so a short queue never reads as an empty one. Accepting is still a human act.');
  return lines.join('\n');
}
