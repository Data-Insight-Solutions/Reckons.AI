/**
 * APPLYING A VERDICT REACHED OUTSIDE THE APP (F199).
 *
 * `reckons review` and the kb_review_* MCP tools do not write graphs. They append a verdict to
 * `knowledge.decisions.jsonl`, and this module decides what — if anything — that verdict is
 * allowed to do to the statements already in the graph.
 *
 * THE JOURNAL CROSSES A TRUST BOUNDARY IN THE OPPOSITE DIRECTION TO THE QUEUE, which is the
 * reason it is a separate file and a separate parser. pending-entry.ts guards proposals coming IN
 * from many writers; this guards DECISIONS coming in from a terminal and claiming to settle them.
 * A cast is not validation in either direction.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS NOT OPTIONAL:
 *
 *   SELF-SETTLEMENT. An agent may not settle a proposal that the SAME agent made. This is F52
 *   (agent-edit-boundary.ts) applied to the one hole the journal opens: an agent cannot land a
 *   settled fact directly, so an agent that could accept its own proposal would simply have
 *   found a two-step route to the same place — propose, then accept, with a human's account on
 *   the second step and nobody having read either. The check is a comparison of the settling
 *   agentId against the statement's `proposedBy`, and it is the whole reason actor.ts records
 *   WHICH agent rather than merely that one was present.
 *
 *   UNKNOWN SUBJECTS. A verdict names a decision by id and the statements by triple. If nothing
 *   matches, the verdict is retained rather than discarded — a decision recorded against a row
 *   that has not been drained yet is early, not wrong, and deleting it would silently lose a
 *   judgment somebody actually made.
 *
 * WHAT IT STILL CANNOT DO, said here rather than in a footnote: the journal is a local JSON file
 * and carries no credential. `actor` is observed rather than self-declared (actor.ts), which
 * makes an agent-routed verdict VISIBLE — it does not make a human-routed one provable. Every
 * statement this module settles is stamped with `settledBy`, so the channel travels with the
 * fact forever and a reader can discount it accordingly.
 */

import { gateFactWrite } from './agent-edit-boundary';
import type { ReviewStatus, Statement } from './types';

/** Mirrors the Verdict written by mcp-server/src/review-session.ts. Validated, never cast. */
export interface DecisionVerdict {
  decision: string;
  verdict: 'accept' | 'reject' | 'defer' | 'ask';
  claim?: string;
  rows: string[];
  subject: string;
  predicate: string;
  object?: string;
  objects?: string[];
  supersedes?: string[];
  kb: string;
  note?: string;
  actor: {
    user: string;
    host: string;
    route: 'cli' | 'mcp';
    agent: boolean;
    session?: string;
    agentId?: string;
    interactive?: boolean;
    attestation: string;
  };
  at: string;
}

export type DecisionIssueCode =
  | 'malformed-json'
  | 'not-an-object'
  | 'missing-decision'
  | 'unknown-verdict'
  | 'missing-subject'
  | 'missing-predicate'
  | 'missing-actor'
  | 'accept-without-object';

export interface DecisionIssue { line: number; code: DecisionIssueCode; message: string }

const VERDICTS = new Set(['accept', 'reject', 'defer', 'ask']);

export function parseDecisionLine(
  line: string,
): { ok: true; verdict: DecisionVerdict } | { ok: false; code: DecisionIssueCode; message: string } {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return { ok: false, code: 'malformed-json', message: 'not JSON' }; }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, code: 'not-an-object', message: 'not a JSON object' };
  }
  const v = raw as Record<string, unknown>;

  if (typeof v.decision !== 'string' || v.decision.trim() === '') {
    return { ok: false, code: 'missing-decision', message: 'no decision id' };
  }
  if (typeof v.verdict !== 'string' || !VERDICTS.has(v.verdict)) {
    return { ok: false, code: 'unknown-verdict', message: `unknown verdict ${String(v.verdict)}` };
  }
  if (typeof v.subject !== 'string' || v.subject.trim() === '') {
    return { ok: false, code: 'missing-subject', message: 'no subject' };
  }
  if (typeof v.predicate !== 'string' || v.predicate.trim() === '') {
    return { ok: false, code: 'missing-predicate', message: 'no predicate' };
  }
  /*
   * A verdict with no actor is refused rather than defaulted. Defaulting would invent an identity
   * for a settlement, which is worse than having none: the handoff's rule is that a settled fact
   * whose settler is unknown is worse than an unsettled one, because it looks accounted for.
   */
  const actor = v.actor as DecisionVerdict['actor'] | undefined;
  if (!actor || typeof actor !== 'object' || typeof actor.user !== 'string' || typeof actor.route !== 'string') {
    return { ok: false, code: 'missing-actor', message: 'no observed actor — a settlement with no settler is refused' };
  }
  if (v.verdict === 'accept' && typeof v.object !== 'string' && !Array.isArray(v.objects)) {
    return { ok: false, code: 'accept-without-object', message: 'accept names no object' };
  }

  return { ok: true, verdict: raw as DecisionVerdict };
}

export interface DecisionJournalPartition {
  verdicts: DecisionVerdict[];
  issues: DecisionIssue[];
}

export function parseDecisionJsonl(text: string): DecisionJournalPartition {
  const verdicts: DecisionVerdict[] = [];
  const issues: DecisionIssue[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parseDecisionLine(trimmed);
    if (parsed.ok) verdicts.push(parsed.verdict);
    else issues.push({ line: index + 1, code: parsed.code, message: parsed.message });
  }
  return { verdicts, issues };
}

/** One statement's status change, with the provenance that must travel with it. */
export interface StatementChange {
  id: string;
  status: ReviewStatus;
  settledBy: { actor: string; channel: string; at: number };
  settledByDecision: string;
  /** Why this statement changed — for the log and for the review UI. */
  reason: string;
}

export interface ApplyOutcome {
  changes: StatementChange[];
  /** Verdicts that matched nothing yet. Kept in the journal: early is not wrong. */
  unmatched: DecisionVerdict[];
  /** Verdicts refused, with the reason. Kept in the journal so the refusal stays visible. */
  refused: { verdict: DecisionVerdict; reason: string }[];
  /** Decision ids fully applied — the only ones safe to consume from the journal. */
  applied: string[];
}

/** `matt@12chi-core via cli` — what goes into `settledBy.actor`, observed rather than claimed. */
export function settlerActor(a: DecisionVerdict['actor']): string {
  return `${a.user}@${a.host}`;
}

/**
 * The channel, which is the part a reader needs to discount a settlement correctly.
 *
 * `cli:agent` and `cli:tty` are not the same event and must not read alike in the graph. The app's
 * own review screen writes `app:review` (fact-aggregation.ts), so these sit beside it in the same
 * vocabulary rather than inventing a parallel one.
 */
export function settlerChannel(a: DecisionVerdict['actor']): string {
  if (a.agent) return `${a.route}:agent${a.agentId ? `:${a.agentId}` : ''}`;
  if (a.route === 'cli') return a.interactive ? 'cli:tty' : 'cli:script';
  return 'mcp:client';
}

/** Statements a verdict is about: same subject and predicate, still awaiting a decision. */
function candidates(v: DecisionVerdict, statements: readonly Statement[]): Statement[] {
  return statements.filter((st) =>
    st.s.value === v.subject
    && st.p.value === v.predicate
    && (st.status === 'pending' || st.status === 'pending-removal'));
}

/**
 * Decide what a batch of journalled verdicts does to the graph. PURE — it does not write.
 *
 * Ordering note: verdicts are applied in journal order, so a later verdict on the same decision
 * overrides an earlier one. That is the same rule a person gets by clicking twice, and it makes
 * the journal replayable.
 */
export function applyVerdicts(
  verdicts: readonly DecisionVerdict[],
  statements: readonly Statement[],
  now: number = Date.now(),
): ApplyOutcome {
  const changes = new Map<string, StatementChange>();
  const unmatched: DecisionVerdict[] = [];
  const refused: { verdict: DecisionVerdict; reason: string }[] = [];
  const applied: string[] = [];

  for (const v of verdicts) {
    // `defer` and `ask` change no status. They are recorded so a person can see they were
    // considered — a decision deliberately left open is information, not an absence.
    if (v.verdict === 'defer' || v.verdict === 'ask') { applied.push(v.decision); continue; }

    const matches = candidates(v, statements);
    if (matches.length === 0) { unmatched.push(v); continue; }

    /*
     * F52, THE ONE HOLE THIS FEATURE COULD OPEN. An agent may not settle a proposal it made
     * itself: propose-then-accept is the same wall climbed in two steps. Checked against every
     * matching statement, and one self-proposal refuses the whole verdict rather than settling
     * the rest — a partially-applied verdict is harder to reason about than a refused one.
     */
    const own = v.actor.agentId
      ? matches.filter((st) => st.proposedBy && sameAgent(st.proposedBy, v.actor.agentId!))
      : [];
    if (own.length > 0) {
      refused.push({
        verdict: v,
        reason:
          `${v.actor.agentId} proposed ${own.length === matches.length ? 'this' : 'one of these'} `
          + `and cannot also settle it (F52). A person must accept it in the app, or from a `
          + `terminal that is not running the same agent.`,
      });
      continue;
    }

    const settledBy = { actor: settlerActor(v.actor), channel: settlerChannel(v.actor), at: now };

    for (const st of matches) {
      const isAccepted = v.verdict === 'accept' && matchesAccepted(st, v);
      const requested: ReviewStatus = isAccepted
        ? 'confirmed'
        : v.verdict === 'reject'
          ? 'rejected'
          : (v.supersedes ?? []).includes(st.o.value) ? 'superseded' : 'pending';

      // Nothing changes for a statement this verdict does not speak to.
      if (requested === 'pending') continue;

      /*
       * The boundary still runs, even though this is a human's decision arriving by an agent's
       * hand. `agent` for an agent-routed verdict means a settled status is DOWNGRADED rather
       * than landed — so an agent relaying an accept for a proposal it did not make still cannot
       * confirm it silently; it moves it back into review with the channel recorded. Rejections
       * and supersessions are terminal dispositions, not fresh assertions, and pass through.
       */
      const gate = gateFactWrite(v.actor.agent ? 'agent' : 'human', requested);
      changes.set(st.id, {
        id: st.id,
        status: gate.status,
        settledBy,
        settledByDecision: v.decision,
        reason: gate.coerced
          ? `${v.verdict} via ${settledBy.channel} — ${gate.reason}`
          : `${v.verdict} via ${settledBy.channel}${v.note ? ` — ${v.note}` : ''}`,
      });
    }
    applied.push(v.decision);
  }

  return { changes: [...changes.values()], unmatched, refused, applied };
}

/** Does this statement hold the object the verdict accepted? Handles `all` on a batch. */
function matchesAccepted(st: Statement, v: DecisionVerdict): boolean {
  if (v.claim === 'all') return (v.objects ?? []).includes(st.o.value);
  return st.o.value === v.object;
}

/**
 * Two agent labels naming the same agent.
 *
 * Queue rows spell an agent several ways for one program — `claude-code`, `offline:code-review
 * (qwen3-coder:latest)` — so an exact match would miss the case the check exists for. Comparing
 * on the leading identifier catches `claude-code` against `claude-code (opus)` without treating
 * every offline job as the same agent.
 */
export function sameAgent(proposedBy: string, agentId: string): boolean {
  const head = (s: string) => s.trim().toLowerCase().split(/[\s(]/)[0];
  return head(proposedBy) === head(agentId);
}
