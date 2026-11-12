#!/usr/bin/env npx tsx
/**
 * NO AGENT SETTLES ITS OWN PROPOSALS — F286.7 (script tier).
 *
 * Reads TWO files given as arguments — a queue and a decision journal, both JSON lines — and
 * counts how many of the journal's verdicts settle a row the same agent proposed. For every
 * journal line with a rows list, the covered queue rows are found by row id (rowId, the same
 * identity the app already uses in mcp-server/src/review-session.ts) and the verdict is flagged
 * when its actor's agent id is the same agent that proposed a covered row (sameAgent, the same
 * label comparison the app uses in src/lib/rdf/decision-journal.ts, so `claude-code (opus)`
 * still counts as `claude-code`). A verdict whose rows are no longer in the queue is counted as
 * NOT CHECKABLE, not as a failure: the row may have been settled, rejected or deduped, and no
 * live record of who proposed it remains for this check to read.
 *
 * It READS ONLY. It never writes a file, never settles anything, and never appends to a queue.
 * Exit 0 no verdict flagged, 1 at least one self-settled verdict (each decision id named with
 * its agent), 2 no arguments or a file missing.
 *
 * WEAKNESS, stated rather than footnoted: like the journal itself, this trusts the labels it
 * reads. A row whose agent says `local-deputy` and a verdict whose actor says `local-deputy`
 * are the same label and are caught — a verdict hand-edited to drop its agentId is not. The
 * check finds what is visible; it cannot prove what is hidden.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rowId } from '../../mcp-server/src/review-session.js';
import type { PendingRow } from '../../mcp-server/src/review-links.js';
import { sameAgent } from '../../src/lib/rdf/decision-journal.js';

/** A journal line as far as this check cares. The rest of the schema is parseDecisionLine's job. */
export interface JournalLine {
  decision?: string;
  rows?: unknown;
  actor?: { agentId?: unknown };
}

export interface Flagged {
  decision: string;
  /** The actor's agent label, as written in the journal. */
  agent: string;
  /** Covered rows that were found in the queue. */
  covered: number;
  /** Of those, the rows the same agent proposed. */
  own: number;
}

export interface SelfSettlementResult {
  /** Verdicts with at least one covered row in the queue. */
  checked: number;
  /** Verdicts whose actor settled a row the same agent proposed. */
  selfSettled: Flagged[];
  /** Verdicts whose rows are all gone from the queue — not checkable, not a failure. */
  notCheckable: number;
}

export function findSelfSettlements(
  queue: readonly PendingRow[],
  verdicts: readonly JournalLine[],
): SelfSettlementResult {
  const inQueue = new Map<string, PendingRow>();
  for (const row of queue) inQueue.set(rowId(row), row);

  let checked = 0;
  let notCheckable = 0;
  const selfSettled: Flagged[] = [];

  for (const v of verdicts) {
    // A journal line without a rows list is not a verdict for this check: it is neither
    // checked nor not-checkable, only the lines that name rows are counted.
    if (!Array.isArray(v.rows)) continue;
    const ids = v.rows.filter((id): id is string => typeof id === 'string');
    const covered = ids
      .map((id) => inQueue.get(id))
      .filter((row): row is PendingRow => row !== undefined);
    if (covered.length === 0) { notCheckable += 1; continue; }
    checked += 1;

    const agentId = typeof v.actor?.agentId === 'string' ? v.actor.agentId.trim() : '';
    if (!agentId) continue;

    // A covered row with no recorded proposer cannot be matched — the label may have been
    // absent, not different. Same agent as proposedBy-vs-agentId in applyVerdicts.
    const own = covered.filter((row) => typeof row.agent === 'string' && row.agent.trim() !== ''
      && sameAgent(row.agent, agentId));
    if (own.length > 0) {
      selfSettled.push({
        decision: v.decision ?? '',
        agent: agentId,
        covered: covered.length,
        own: own.length,
      });
    }
  }

  return { checked, selfSettled, notCheckable };
}

/** JSONL with unparseable lines skipped: a line without a rows list is simply not a verdict here. */
function readJsonl<T>(file: string): T[] {
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const raw: unknown = JSON.parse(trimmed);
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) out.push(raw as T);
    } catch { /* a malformed line is not this check's job */ }
  }
  return out;
}

export function checkFiles(queueFile: string, journalFile: string): SelfSettlementResult {
  return findSelfSettlements(readJsonl<PendingRow>(queueFile), readJsonl<JournalLine>(journalFile));
}

/** The whole run, returning the exit code instead of exiting so the tests can call it. */
export function runSelfSettlementCheck(queueArg: string | undefined, journalArg: string | undefined): number {
  if (!queueArg || !journalArg) {
    console.error('usage: self-settlement-check.ts <queue.jsonl> <decisions.jsonl>');
    return 2;
  }
  const queueFile = path.resolve(queueArg);
  const journalFile = path.resolve(journalArg);
  if (!existsSync(queueFile) || !existsSync(journalFile)) {
    console.error('self-settlement-check: the queue or the journal file is missing; nothing to check');
    return 2;
  }

  const { checked, selfSettled, notCheckable } = checkFiles(queueFile, journalFile);
  console.log(`self-settlement-check: checked ${checked} verdict(s), ${selfSettled.length} self-settled, ${notCheckable} not checkable`);
  if (selfSettled.length === 0) return 0;

  for (const f of selfSettled) {
    console.error(`  ${f.decision}: ${f.agent} settled ${f.own} of ${f.covered} covered row(s) it proposed`);
  }
  return 1;
}

function main(): void {
  const [queueArg, journalArg] = process.argv.slice(2);
  process.exit(runSelfSettlementCheck(queueArg, journalArg));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main();
