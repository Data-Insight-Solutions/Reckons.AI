/**
 * A PROPOSAL: a target state that does not hold yet, offered as 2 to 4 options (F223.1).
 *
 * Matt, 2026-09-29: SHACL shapes for the target state, schema:Action status for the lifecycle.
 * Matt, 2026-10-13: an option whose citation cannot be resolved is SHOWN, FLAGGED, never hidden,
 * because hiding it would silently drop a judgment (kb:evidence-chain).
 *
 * WHAT THIS IS AND IS NOT.
 *   - Pure rules, no model, no storage. Nothing writes a proposal into storage yet (F223.2 builds
 *     options from a reckoning, F223.3 shows them); this is the shape and the lifecycle.
 *   - The well-formedness rules mirror `kshape:Proposal` in static/reckons-vocabulary.ttl; a test
 *     keeps the status list in agreement with it.
 *   - The TARGET STATE check is a deliberately small subset of SHACL (required facts, optionally
 *     with a required object), evaluated over REVIEWED facts only (confirmed or refined). It is
 *     not a SHACL engine. No inference and no model decides that a proposal is reached.
 *   - The decision-journal rule carries over: an agent may not settle a proposal it made itself.
 */
import { isIRI, type Statement } from './types';
import { checkAnchor } from '../ingest/statement-evidence';

const SCHEMA = 'https://schema.org/';
export const ACTION_STATUS = {
  potential: `${SCHEMA}PotentialActionStatus`,
  active: `${SCHEMA}ActiveActionStatus`,
  completed: `${SCHEMA}CompletedActionStatus`,
  failed: `${SCHEMA}FailedActionStatus`,
} as const;
export type ActionStatus = (typeof ACTION_STATUS)[keyof typeof ACTION_STATUS];
export const ACTION_STATUSES: readonly string[] = Object.values(ACTION_STATUS);

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;

/** What must hold in the reviewed facts for the proposal to be reached. */
export type TargetShape = {
  id: string;
  /** `o`: an IRI string, `{ literal }` for a text value, or omitted to accept any object. */
  requirements: { s: string; p: string; o?: string | { literal: string } }[];
};

export type ProposalOption = {
  id: string;
  label: string;
  /** Ids of the facts the option rests on. */
  citations: string[];
};

export type Proposal = {
  id: string;
  /** Who made it (an agent id, or 'person'); the settler may not be the same agent. */
  proposedBy?: string;
  status: string;
  targetShape: TargetShape | null;
  options: ProposalOption[];
  recommendedId: string | null;
};

export type ProposalIssueCode =
  | 'unknown-status' | 'no-target-shape' | 'too-few-options' | 'too-many-options'
  | 'duplicate-option' | 'no-recommended' | 'recommended-not-an-option' | 'option-without-citation';

export type ProposalIssue = { code: ProposalIssueCode; message: string };

/** What a well-formed proposal carries, each failure with a named reason. */
export function validateProposal(p: Proposal): ProposalIssue[] {
  const issues: ProposalIssue[] = [];
  const add = (code: ProposalIssueCode, message: string) => issues.push({ code, message });
  if (!ACTION_STATUSES.includes(p.status)) add('unknown-status', `"${p.status}" is not one of the four action statuses.`);
  if (!p.targetShape?.requirements?.length) add('no-target-shape', 'A proposal needs a target state that can be checked.');
  const n = p.options.length;
  if (n < MIN_OPTIONS) add('too-few-options', `${n} option${n === 1 ? '' : 's'}; a proposal offers at least ${MIN_OPTIONS}.`);
  if (n > MAX_OPTIONS) add('too-many-options', `${n} options; a proposal offers at most ${MAX_OPTIONS}.`);
  if (new Set(p.options.map((o) => o.id)).size !== n) add('duplicate-option', 'Two options repeat an id.');
  if (!p.recommendedId) add('no-recommended', 'No option is marked recommended.');
  else if (!p.options.some((o) => o.id === p.recommendedId)) add('recommended-not-an-option', 'The recommended option is not one of the options.');
  // An uncited option may exist (it is shown), but it is named so the reader can see it.
  for (const o of p.options) if (o.citations.length === 0) add('option-without-citation', `Option "${o.label}" cites nothing.`);
  return issues;
}

/** Malformed means any issue except an uncited option, which is a warning the reader sees. */
export const isWellFormed = (p: Proposal): boolean => validateProposal(p).every((i) => i.code === 'option-without-citation');

// ── Lifecycle (schema:Action) ───────────────────────────────────────────────────

const NEXT: Record<string, readonly string[]> = {
  [ACTION_STATUS.potential]: [ACTION_STATUS.active, ACTION_STATUS.failed],
  [ACTION_STATUS.active]: [ACTION_STATUS.completed, ACTION_STATUS.failed],
  [ACTION_STATUS.completed]: [],
  [ACTION_STATUS.failed]: [],
};

export function canTransition(from: string, to: string): boolean {
  return (NEXT[from] ?? []).includes(to);
}

export type Transition =
  | { ok: true; proposal: Proposal }
  | { ok: false; reason: 'bad-transition' | 'self-settlement' | 'no-actor' | 'not-well-formed'; message: string };

const shortStatus = (s: string) => s.replace(SCHEMA, '').replace('ActionStatus', '').toLowerCase();

/**
 * Move a proposal along its lifecycle. Settling (completing or failing) is refused to the agent that
 * made the proposal. Activating requires a well-formed proposal, so a malformed one never runs.
 */
export type Actor = {
  /** An agent acting; it may not settle its own proposal. */
  agentId?: string;
  /** A person acting. */
  person?: boolean;
  /** The deterministic target-state check (closeIfReached): no opinion is involved. */
  system?: boolean;
};

export function advanceProposal(p: Proposal, to: ActionStatus, actor: Actor = {}): Transition {
  if (!canTransition(p.status, to)) {
    return { ok: false, reason: 'bad-transition', message: `A proposal cannot go from ${shortStatus(p.status)} to ${shortStatus(to)}.` };
  }
  if (to === ACTION_STATUS.active && !isWellFormed(p)) {
    return { ok: false, reason: 'not-well-formed', message: 'A proposal that is not well formed cannot be made active.' };
  }
  const settling = to === ACTION_STATUS.completed || to === ACTION_STATUS.failed;
  if (settling && actor.agentId && p.proposedBy && actor.agentId === p.proposedBy) {
    return { ok: false, reason: 'self-settlement', message: 'An agent may not settle a proposal it made itself.' };
  }
  // A settlement with no observed actor is refused, as the decision journal refuses one: it would
  // let any caller close an agent's proposal without being anyone.
  if (settling && !actor.agentId && !actor.person && !actor.system) {
    return { ok: false, reason: 'no-actor', message: 'Settling a proposal needs to say who is settling it.' };
  }
  return { ok: true, proposal: { ...p, status: to } };
}

// ── The target state ────────────────────────────────────────────────────────────

const REVIEWED = new Set(['confirmed', 'refined']);
const iriOf = (t: Statement['s']): string | null => (isIRI(t) ? t.value : null);
function objectMatches(want: NonNullable<TargetShape['requirements'][number]['o']>, got: Statement['o']): boolean {
  if (typeof want === 'string') return isIRI(got) && got.value === want;
  return !isIRI(got) && String((got as { value?: unknown }).value) === want.literal;
}

export type TargetResult = { reached: boolean; missing: TargetShape['requirements'] };

/** Is every requirement held by a REVIEWED fact? A pending fact does not count: nobody has accepted it. */
export function targetReached(shape: TargetShape, facts: readonly Statement[]): TargetResult {
  const reviewed = facts.filter((st) => REVIEWED.has(st.status));
  const missing = shape.requirements.filter((r) =>
    !reviewed.some((st) => iriOf(st.s) === r.s && iriOf(st.p) === r.p && (r.o === undefined || objectMatches(r.o, st.o))));
  return { reached: missing.length === 0, missing };
}

/**
 * Close an active proposal when the reviewed facts reach its target; otherwise leave it active. Never
 * fails a proposal by itself (failing is a person's call) and never completes one that is not active.
 */
export function closeIfReached(p: Proposal, facts: readonly Statement[]): Transition {
  if (p.status !== ACTION_STATUS.active || !p.targetShape) {
    return { ok: false, reason: 'bad-transition', message: 'Only an active proposal with a target state can be closed.' };
  }
  if (!targetReached(p.targetShape, facts).reached) return { ok: true, proposal: p };
  return advanceProposal(p, ACTION_STATUS.completed, { system: true });
}

// ── Citations: shown, flagged, never hidden ─────────────────────────────────────

export type CitationState =
  | 'unresolved' // no such fact among the stored facts
  | 'resolved'   // the fact exists; no stored anchor, or no kept text to check it against
  | 'anchored'   // the fact's stored anchor still reads as its quote
  | 'stale';     // the stored anchor no longer holds: the document changed since extraction

export type ResolvedCitation = { statementId: string; state: CitationState };

/**
 * One entry per citation, in order, nothing dropped. `textFor` supplies the kept text for a fact's
 * document (and its revision hash) so a stored anchor (F122.1.1) can be checked with `checkAnchor`.
 */
export function resolveCitations(
  ids: readonly string[],
  facts: readonly Statement[],
  textFor?: (st: Statement) => { text: string; hash?: string } | null,
): ResolvedCitation[] {
  const byId = new Map(facts.map((st) => [st.id, st]));
  return ids.map((statementId): ResolvedCitation => {
    const st = byId.get(statementId);
    if (!st) return { statementId, state: 'unresolved' };
    if (!st.anchor || !st.excerpt || !textFor) return { statementId, state: 'resolved' };
    let kept: ReturnType<NonNullable<typeof textFor>>;
    try { kept = textFor(st); } catch { kept = null; } // a failing lookup must not drop the citation
    if (!kept) return { statementId, state: 'resolved' };
    const check = checkAnchor(st.anchor, kept.text, st.excerpt, kept.hash);
    return { statementId, state: check.ok ? 'anchored' : 'stale' };
  });
}

/** The citations a reader should be warned about. */
export const flaggedCitations = (cs: readonly ResolvedCitation[]) => cs.filter((c) => c.state === 'unresolved' || c.state === 'stale');
