/**
 * THE REVIEW PROCEDURE — settling a claim without opening the app (F199).
 *
 * Matt, 2026-09-10: "we need a cli and mcp review procedure… I will ideally use Claude Code chat
 * to review critical decisions, and choose a claim."
 *
 * WHY THIS EXISTS. Everything in this repository can PROPOSE and nothing outside the browser can
 * SETTLE. Twenty offline jobs append to knowledge.pending.jsonl, kb_add_note appends to it, and
 * kb_review_links mints URLs into it — while the only accept button lives in a SvelteKit route.
 * That asymmetry is the whole explanation for 1,046 unruled rows: proposing costs a script one
 * line, and settling costs a person a context switch into a different program. This closes the
 * loop at the end where the imbalance actually is.
 *
 * A DECISION IS THE UNIT, NOT A ROW. Three rows that share a subject and predicate but propose
 * three different objects are not three chores — they are ONE question with three candidate
 * answers, and choosing between them is what Matt means by choosing a claim. Grouping them is
 * also the only presentation in which rejecting the losers is IMPLIED by accepting the winner
 * rather than being two more decisions to make later.
 *
 * IT SETTLES NOTHING BY ITSELF. A verdict is appended to knowledge.decisions.jsonl and the app
 * applies it on the next drain. This module never writes a graph, never edits a TTL, and never
 * removes a queue row — so a wrong verdict is a line in a journal, not a lost fact.
 *
 * WHAT IT CANNOT DO, STATED HERE RATHER THAN IN A FOOTNOTE. The journal cannot prove who wrote
 * it. This is the same weakness src/lib/rdf/pending-entry.ts already names about `verifiedBy` and
 * `verificationClaim`: it travels in an untrusted local JSON file and is not an authentication
 * credential. The threat that matters is not forgery by a stranger — it is an AGENT SETTLING ITS
 * OWN PROPOSALS and reporting that a person did.
 *
 * The first draft of this file made that worse by carrying a `by: string` the CALLER filled in,
 * which is a claim about identity dressed as a record of one. Matt caught it the same day:
 * "We could ask who is currently using CLI, record local system user, etc?" So identity is now
 * OBSERVED — see actor.ts, which reads the OS account, the machine, and whether the harness
 * reports an AI agent in the loop, none of which the caller supplies. That still is not a
 * credential, and an agent running as `matt` still reports `matt`; what it buys is that an agent
 * settling its own proposals is VISIBLE in the journal instead of indistinguishable from a person.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { appendPendingLines } from './pending-file.js';
import { actorLine, type Actor } from './actor.js';
import type { PendingRow } from './review-links.js';

/** The journal the app drains. A sibling of the queue, deliberately not the queue itself. */
export const DECISIONS_FILE = 'knowledge.decisions.jsonl';

export type VerdictKind = 'accept' | 'reject' | 'defer' | 'ask';

export interface Verdict {
  /** The decision this settles — `decisionId`, stable across runs. */
  decision: string;
  verdict: VerdictKind;
  /** For `accept`: the claim id being accepted. Every competing claim is superseded. */
  claim?: string;
  /** The row ids this verdict covers, so the app can match without re-deriving the grouping. */
  rows: string[];
  subject: string;
  predicate: string;
  /** The accepted object, denormalised so the journal is readable without the queue beside it. */
  object?: string;
  /** Every accepted object, when `claim` is `all` and a whole batch was taken. */
  objects?: string[];
  /**
   * Objects this acceptance SUPERSEDES — empty for a batch, the rivals for a choice.
   *
   * Written into the record rather than left to be re-derived. Whoever applies a verdict should
   * not have to repeat the arity measurement to discover whether it was destructive.
   */
  supersedes?: string[];
  kb: string;
  /** Why. Free text, and the only part of a verdict a future reader cannot reconstruct. */
  note?: string;
  /**
   * Who wrote it, OBSERVED from the process rather than supplied by the caller (actor.ts).
   *
   * This replaced a `by: string` the caller filled in. A self-declared name is a claim about
   * identity; this is the account, the machine, the route, and whether the harness reports an AI
   * agent in the loop — none of which the caller can assert its way out of. It is still not a
   * credential, and `actor.attestation` says so in words beside every row.
   */
  actor: Actor;
  at: string;
}

/** One candidate answer to a decision — an object value, and the rows that proposed it. */
export interface Claim {
  /** Short, stable, and derived from the value: `c1`-style ordinals would move between runs. */
  id: string;
  object: string;
  objectKind?: 'literal' | 'iri';
  /** Every row proposing this same object. Repetition across jobs is weak corroboration. */
  rows: PendingRow[];
  rowIds: string[];
  /** The distinct agents that proposed it — one job saying it twice is not two witnesses. */
  proposers: string[];
  /** Highest priority any proposing row carried. */
  priority: string;
  /** True when no proposer is a machine job: the person's own word (F194's `user` gate). */
  humanAttested: boolean;
  /** Explanatory notes from the proposing rows, deduplicated. */
  notes: string[];
}

export interface Decision {
  id: string;
  kb: string;
  subject: string;
  predicate: string;
  /** The written question when a row carried one, otherwise derived from subject + predicate. */
  question: string;
  /** Candidate answers, strongest first. More than one means a claim must be CHOSEN. */
  claims: Claim[];
  /**
   * What KIND of decision this is, which governs whether accepting one claim kills the others.
   *
   * THIS DISTINCTION WAS MISSING FROM THE FIRST DRAFT AND THE OMISSION WAS DESTRUCTIVE. Run
   * against the real 1,038-row queue on 2026-09-10, the top-ranked "decision" was
   * `kb:journey-docs kpred:unexplained-term` with NINETY-FOUR competing claims — which are not
   * competing at all. They are 94 different unexplained terms, every one of which can be true at
   * once. Accepting one would have superseded 93 correct observations, and the interface would
   * have called that settling a decision.
   *
   *   'choice'  the predicate holds at most one value, so the claims genuinely compete and
   *             accepting one supersedes the rest. `has-status` is the type case.
   *   'batch'   the predicate accumulates, so the claims are independent and accepting one
   *             supersedes NOTHING. `principle`, `has-file`, `unexplained-term`.
   *   'single'  one claim; accept or reject it on its own.
   */
  kind: 'choice' | 'batch' | 'single';
  /** True only for a genuine CHOICE whose claims cannot both stand. A batch is never contested. */
  contested: boolean;
  /**
   * Set when this contest is between claims a person attested on both sides. Accept/reject is the
   * wrong control for that (review-tree.ts: `escalate: 'stp'`), and the procedure refuses it.
   */
  escalate: 'stp' | null;
  /** Rows asking a question with no object proposed at all — a partial fact, F32. */
  open: boolean;
  /** Queue types present, e.g. `question`, `drift-warning`. */
  types: string[];
  priority: string;
  /** Most recent addedAt across the rows, ISO, or '' when none carried one. */
  latest: string;
  rowIds: string[];
  /** Ranking score. Reported so an order that looks wrong can be argued with. */
  score: number;
  /** The one-line reason this decision ranks where it does. */
  because: string;
}

const PRIORITY_RANK: Record<string, number> = { high: 3, medium: 2, normal: 2, low: 1 };

export type Arity = 'functional' | 'multi';

/**
 * Which predicates hold at most ONE value per subject — MEASURED from the graph, not declared.
 *
 * The vocabulary declares no cardinality (checked 2026-09-10: no owl:FunctionalProperty, no
 * kpred:cardinality anywhere in static/reckons-vocabulary.ttl), so the only honest source is what
 * the graph has actually done. A predicate that has never carried two values for one subject is
 * treated as functional; one that has, is not. On reckons-roadmap.ttl this reads `has-status`
 * (351 subjects, 0 plural), `feature-id` and `priority` as functional, and `principle` (101 of
 * 191 plural), `decided`, `has-file` and `measured` as multi — which is correct in every case.
 *
 * IT ERRS TOWARD `multi`, DELIBERATELY. One accidental duplicate in the graph will mark a
 * genuinely functional predicate as multi-valued, and the cost of that is a missed "choose one"
 * prompt. The cost of the opposite error is superseding facts that were all true. A predicate the
 * graph has never seen is unknown, and unknown resolves to multi for the same reason.
 *
 * WHICH IS WHY THIN EVIDENCE IS NOT EVIDENCE. Caught on the live queue, 2026-09-10:
 * `kpred:server-health` appeared on a couple of subjects, never twice, and was therefore called
 * functional — so the procedure offered `n8n: kernel` and `n8n: reboot` as COMPETING claims and
 * would have superseded one on accepting the other. They are both true; the predicate accumulates;
 * the graph simply had not yet recorded a subject with two. "Never plural" over two subjects is
 * indistinguishable from "not plural yet", so a predicate must be seen on at least
 * MIN_SUBJECTS_FOR_FUNCTIONAL subjects before its single-valuedness is believed.
 */
export const MIN_SUBJECTS_FOR_FUNCTIONAL = 8;

export function predicateArity(
  triples: readonly { subject: string; predicate: string; object: string }[],
): Map<string, Arity> {
  const objects = new Map<string, Set<string>>();
  for (const t of triples) {
    const key = JSON.stringify([t.subject, localName(t.predicate)]);
    let set = objects.get(key);
    if (!set) objects.set(key, (set = new Set()));
    set.add(t.object);
  }
  const plural = new Set<string>();
  const subjects = new Map<string, number>();
  for (const [key, values] of objects) {
    const [, predicate] = JSON.parse(key) as [string, string];
    subjects.set(predicate, (subjects.get(predicate) ?? 0) + 1);
    if (values.size > 1) plural.add(predicate);
  }
  const arity = new Map<string, Arity>();
  for (const [p, count] of subjects) {
    const functional = !plural.has(p) && count >= MIN_SUBJECTS_FOR_FUNCTIONAL;
    arity.set(p, functional ? 'functional' : 'multi');
  }
  return arity;
}

/**
 * The comparable part of a predicate.
 *
 * Queue rows spell predicates inconsistently — `kpred:has-status`, the full
 * `urn:kbase:predicate/has-status`, and bare `server-health` all appear in the live queue — while
 * the graph always holds full IRIs. Comparing on the local name is what lets an arity measured
 * from the graph apply to a row at all.
 */
export function localName(iri: string): string {
  const tail = iri.split(/[/#]/).pop() ?? iri;
  return (tail.includes(':') ? tail.split(':').pop()! : tail).trim();
}

/**
 * Agents that are machines proposing, not people asserting.
 *
 * DELIBERATELY A DENY-LIST WITH A PERMISSIVE DEFAULT, and the direction matters. Being wrong by
 * calling a machine "human-attested" promotes a decision into the escalation lane, where the
 * procedure REFUSES to settle it and sends the person to the app — one wasted trip. Being wrong
 * the other way lets a terminal verdict overrule two human claims with no Reckoning, which is the
 * failure this scope rule exists to prevent. So an unrecognised agent counts as human.
 */
const MACHINE_AGENT = /^(offline:|opus:|script:|claude|codex|gpt|gemini|extraction-score|stars-scan|branch-align|kb-align)/i;

/** True when this row is a machine's proposal rather than a person's assertion. */
export function isMachineProposal(row: PendingRow): boolean {
  const agent = (row.agent ?? '').trim();
  if (agent === '') return true; // unattributed rows come from jobs that forgot to sign
  return MACHINE_AGENT.test(agent);
}

/**
 * A row's stable identity.
 *
 * MUST AGREE WITH findingIdentity() in scripts/offline/pending-queue.ts, because that is what the
 * dedupe path already treats as "the same finding" and two identity rules would let a verdict miss
 * the row it was written for. Same components, same order, hashed only so the id is short enough
 * to type into a terminal.
 */
export function rowId(row: PendingRow): string {
  const text = String((row as { question?: unknown }).question ?? row.object ?? '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  const kb = normalizeKb((row as { kb?: unknown }).kb);
  const blocks = normalizeBlocks((row as { blocks?: unknown }).blocks);
  const identity = `${kb}|${String(row.subject ?? '').trim()}|${String(row.predicate ?? '').trim()}|${JSON.stringify(blocks)}|${text}`;
  return createHash('sha256').update(identity).digest('hex').slice(0, 8);
}

export function normalizeKb(value: unknown): string {
  return String(value ?? 'roadmap').trim().toLowerCase()
    .replace(/['"]/g, '').replace(/[^a-z0-9]+/g, '-');
}

function normalizeBlocks(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))].sort();
}

/** A decision's identity: the question being asked, independent of how many claims answer it. */
export function decisionId(kb: string, subject: string, predicate: string): string {
  return createHash('sha256')
    .update(`${normalizeKb(kb)}|${subject.trim()}|${predicate.trim()}`)
    .digest('hex').slice(0, 8);
}

/** A claim's identity: the answer itself, so it survives a re-run that reorders the queue. */
function claimId(decision: string, object: string): string {
  return `${decision}.${createHash('sha256').update(object.trim()).digest('hex').slice(0, 4)}`;
}

/**
 * Group queue rows into decisions, each carrying the claims competing to settle it.
 *
 * The grouping key is graph + subject + predicate, which is the same triple position a claim
 * occupies. Rows proposing the SAME object collapse into one claim with several proposers; rows
 * proposing different objects become the competing claims that make the decision contested.
 *
 * THE KEY IS JSON RATHER THAN A JOINED STRING, deliberately. The first draft joined the three
 * parts with a literal \x01, which is correct at runtime and INVISIBLE IN THE SOURCE — the same
 * defect found in src/lib/rdf/sets.ts on 2026-09-09, where two NUL bytes made grep return nothing
 * for the entire file. JSON.stringify of a tuple is unambiguous, greppable, and cannot collide
 * however the parts are spelled.
 */
export function groupDecisions(rows: PendingRow[], arity?: ReadonlyMap<string, Arity>): Decision[] {
  const byQuestion = new Map<string, PendingRow[]>();
  for (const row of rows) {
    const subject = String(row.subject ?? '').trim();
    const predicate = String(row.predicate ?? '').trim();
    // A row with no subject or predicate names no fact and cannot be a decision about anything.
    if (!subject || !predicate) continue;
    const kb = normalizeKb((row as { kb?: unknown }).kb);
    const key = JSON.stringify([kb, subject, predicate]);
    byQuestion.set(key, [...(byQuestion.get(key) ?? []), row]);
  }

  const decisions: Decision[] = [];
  for (const [key, group] of byQuestion) {
    const [kb, subject, predicate] = JSON.parse(key) as [string, string, string];
    const id = decisionId(kb, subject, predicate);

    const byObject = new Map<string, PendingRow[]>();
    let open = false;
    for (const row of group) {
      const object = String(row.object ?? '').trim();
      // `?` is the placeholder a partial fact writes for an object nobody has supplied (F32).
      if (object === '' || object === '?') { open = true; continue; }
      byObject.set(object, [...(byObject.get(object) ?? []), row]);
    }

    const claims: Claim[] = [...byObject].map(([object, claimRows]) => ({
      id: claimId(id, object),
      object,
      objectKind: claimRows.find((r) => (r as { objectKind?: 'literal' | 'iri' }).objectKind)
        ? (claimRows.find((r) => (r as { objectKind?: 'literal' | 'iri' }).objectKind) as { objectKind?: 'literal' | 'iri' }).objectKind
        : undefined,
      rows: claimRows,
      rowIds: claimRows.map(rowId),
      proposers: [...new Set(claimRows.map((r) => (r.agent ?? '(unattributed)').trim()))],
      priority: topPriority(claimRows),
      humanAttested: claimRows.some((r) => !isMachineProposal(r)),
      notes: [...new Set(claimRows.map((r) => (r.note ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))],
    }));

    claims.sort((a, b) =>
      (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0)
      || b.proposers.length - a.proposers.length
      || a.object.localeCompare(b.object));

    // Unknown predicates resolve to `multi`: see predicateArity. Nothing is superseded on a guess.
    const functional = arity?.get(localName(predicate)) === 'functional';
    const kind: Decision['kind'] = claims.length <= 1 ? 'single' : functional ? 'choice' : 'batch';
    const contested = kind === 'choice';
    /*
     * Escalation is a contest a terminal must not settle. Both sides human-attested means two
     * people (or one person twice, differently) have asserted incompatible things, and picking one
     * is a judgment that needs the Reckoning surface rather than an accept button.
     *
     * Only a CHOICE can escalate. Two people independently observing two true things is not a
     * disagreement, and treating it as one would send every batch to a Reckoning.
     */
    const escalate = contested && claims.every((c) => c.humanAttested) ? 'stp' as const : null;

    const written = group
      .map((r) => (r as { question?: unknown }).question)
      .find((q): q is string => typeof q === 'string' && q.trim() !== '');
    const decision: Decision = {
      id, kb, subject, predicate,
      question: (written ?? '').trim() || derivedQuestion(subject, predicate, claims, open, kind),
      claims,
      kind,
      contested,
      escalate,
      open,
      types: [...new Set(group.map((r) => (r.type ?? '').trim()).filter(Boolean))].sort(),
      priority: topPriority(group),
      latest: group.reduce((acc, r) => (r.addedAt && r.addedAt > acc ? r.addedAt : acc), ''),
      rowIds: group.map(rowId),
      score: 0,
      because: '',
    };
    decision.score = scoreDecision(decision);
    decision.because = explainScore(decision);
    decisions.push(decision);
  }

  return decisions.sort((a, b) => b.score - a.score || a.subject.localeCompare(b.subject));
}

function topPriority(rows: PendingRow[]): string {
  let best = 'low';
  for (const r of rows) {
    const p = (r.priority ?? '').toLowerCase();
    if ((PRIORITY_RANK[p] ?? 0) > (PRIORITY_RANK[best] ?? 0)) best = p;
  }
  return best;
}

/**
 * The question a decision asks when no row wrote one down.
 *
 * Most rows do not carry `question` — 171 of 1,046 on 2026-09-10 — so this is the common path
 * rather than the fallback, and it should read like a question rather than like a triple.
 */
function derivedQuestion(
  subject: string, predicate: string, claims: Claim[], open: boolean, kind: Decision['kind'],
): string {
  const s = shortName(subject);
  const p = shortName(predicate).replace(/-/g, ' ');
  if (open) return `What is ${s}'s ${p}? Nothing has been proposed.`;
  if (kind === 'choice') return `Which of ${claims.length} claims is ${s}'s ${p}?`;
  if (kind === 'batch') return `${claims.length} proposed ${p} values for ${s} — which hold?`;
  return `Is this ${s}'s ${p}?`;
}

/**
 * A listing line must be SCANNABLE, and a question in this queue can run to 600 words.
 *
 * Measured on the live queue, 2026-09-10: the top-ranked question was 640 characters, so an
 * untruncated listing of ten decisions filled a screen with three of them. The full text is one
 * `show` away; a list that cannot be read at a glance is not a list.
 */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** `urn:kbase:concept/graph-publishing` → `graph-publishing`. Terminals are narrow. */
export function shortName(iri: string): string {
  const tail = iri.split(/[/#]/).pop() ?? iri;
  return tail || iri;
}

/**
 * RANK BY CONSEQUENCE, NOT BY ARRIVAL — F195's rule, applied to the fields a ROW actually has.
 *
 * HONEST LIMIT: F195 specifies ranking by what a decision RESOLVES, projected from the roadmap's
 * dependency edges. That projection lives in review-tree.ts and needs Statements in a graph; these
 * rows have not been drained into one. So this ranks on what a row carries — whether claims
 * disagree, priority, how many independent jobs proposed the same thing, and age. It is a weaker
 * signal than the real thing and the two should converge once both populations rank through the
 * same code.
 */
export function scoreDecision(d: Decision): number {
  let score = 0;
  // A contest is the strongest signal in the queue: two claims cannot both stand, so deferring it
  // leaves the graph holding a contradiction rather than merely holding less.
  if (d.contested) score += 40;
  // A BATCH IS RANKED DOWN, NOT UP, however large it is. Ninety-four independent observations from
  // one job is bulk, and F195 says an isolated low-altitude fact belongs at the bottom or in a
  // batch. Sizing it as urgency is what put that pile at the top of the first run.
  if (d.kind === 'batch') score -= 10;
  // An escalation outranks everything for VISIBILITY while being refused for ACTION. Surfacing it
  // is the point — it is the case a person most needs to know is waiting.
  if (d.escalate) score += 20;
  score += (PRIORITY_RANK[d.priority] ?? 0) * 10;
  // Independent corroboration: three different jobs proposing the same object is weak evidence,
  // and weak evidence still beats none. Capped so a chatty job cannot buy rank with repetition.
  score += Math.min(6, d.claims.reduce((n, c) => n + c.proposers.length - 1, 0)) * 2;
  // A question nobody has answered is a well-formed absence (kb:mission), not an empty row.
  if (d.open) score += 8;
  if (d.types.includes('drift-warning')) score += 12;
  if (d.types.includes('question')) score += 6;
  return score;
}

function explainScore(d: Decision): string {
  const parts: string[] = [];
  if (d.escalate) parts.push('two human-attested claims disagree');
  else if (d.contested) parts.push(`${d.claims.length} claims disagree`);
  else if (d.kind === 'batch') parts.push(`${d.claims.length} independent proposals to review as a set`);
  if (d.types.includes('drift-warning')) parts.push('drift');
  if (d.open) parts.push('nothing proposed yet');
  if (d.priority === 'high') parts.push('high priority');
  const corroborated = d.claims.filter((c) => c.proposers.length > 1).length;
  if (corroborated > 0) parts.push(`${corroborated} claim(s) proposed by more than one job`);
  return parts.join(', ') || 'no signal beyond arrival — ranked last on purpose';
}

// ── Reading and rendering ───────────────────────────────────────────────────

export interface DecisionFilter {
  kb?: string;
  /** Only decisions where claims disagree. */
  contested?: boolean;
  /** Only `high` priority. */
  high?: boolean;
  agent?: string;
}

export function filterDecisions(decisions: Decision[], f: DecisionFilter): Decision[] {
  return decisions.filter((d) => {
    if (f.kb && normalizeKb(f.kb) !== d.kb) return false;
    if (f.contested && !d.contested) return false;
    if (f.high && d.priority !== 'high') return false;
    if (f.agent) {
      const needle = f.agent.toLowerCase();
      const proposers = d.claims.flatMap((c) => c.proposers).join(' ').toLowerCase();
      if (!proposers.includes(needle)) return false;
    }
    return true;
  });
}

/** Read a JSONL queue, skipping torn lines rather than reporting nothing. */
export function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try { out.push(JSON.parse(trimmed) as T); } catch { /* one bad line is not a reason to fail */ }
  }
  return out;
}

/** Verdicts already recorded, so a decision is never presented twice. */
export function settledIds(decisionsFile: string): Set<string> {
  return new Set(
    readJsonl<Verdict>(decisionsFile)
      .filter((v) => v.verdict === 'accept' || v.verdict === 'reject')
      .map((v) => v.decision),
  );
}

/** One decision, rendered for a terminal: the question, then the claims, then what to type. */
export function renderDecision(d: Decision, opts: { index?: number; total?: number } = {}): string {
  const lines: string[] = [];
  const position = opts.index !== undefined && opts.total !== undefined
    ? `  [${opts.index + 1} of ${opts.total}]` : '';
  lines.push(`DECISION ${d.id}${position}`);
  lines.push(d.question);
  lines.push('');
  lines.push(`  graph      ${d.kb}`);
  lines.push(`  subject    ${d.subject}`);
  lines.push(`  predicate  ${d.predicate}`);
  lines.push(`  ranked     ${d.score} — ${d.because}`);
  if (d.latest) lines.push(`  last seen  ${d.latest.slice(0, 10)}`);
  lines.push('');

  if (d.claims.length === 0) {
    lines.push('  NO CLAIM HAS BEEN PROPOSED. This is an open question, not a choice —');
    lines.push('  answering it means supplying an object, which this procedure cannot yet do.');
    lines.push('  Record `defer` with a note, or answer it in the app.');
    return lines.join('\n');
  }

  lines.push(
    d.kind === 'choice' ? `  ${d.claims.length} COMPETING CLAIMS — choose one:`
    : d.kind === 'batch' ? `  ${d.claims.length} INDEPENDENT PROPOSALS — this predicate accumulates, so they do not compete:`
    : '  ONE CLAIM:',
  );
  for (const c of d.claims) {
    lines.push('');
    lines.push(`  ${c.id}   ${c.object}`);
    lines.push(`         proposed by ${c.proposers.join(', ')}${c.priority === 'high' ? '  [HIGH]' : ''}`);
    lines.push(`         ${c.humanAttested ? 'attested by a person — nothing else backs it' : 'a machine proposal, ungated'}`);
    for (const note of c.notes.slice(0, 2)) {
      lines.push(`         ${note.length > 160 ? note.slice(0, 160) + '…' : note}`);
    }
  }
  lines.push('');

  if (d.escalate) {
    lines.push('  REFUSED HERE: both sides are human-attested. Accepting one from a terminal would');
    lines.push('  overrule a person with a command. This needs a Reckoning — open the app.');
    return lines.join('\n');
  }

  lines.push(
    d.kind === 'choice'
      ? '  Accepting one SUPERSEDES the others. They are recoverable, not deleted.'
      : d.kind === 'batch'
        ? '  Accepting one leaves the rest exactly as they are — nothing here supersedes anything.\n'
          + '  Accept `all` to take the set, or a claim id to take one.'
        : '  Accepting confirms it. Rejecting marks it rejected and keeps it.',
  );
  return lines.join('\n');
}

/**
 * The whole surface as a list — what to open first, and how much is behind it.
 *
 * AN EMPTY LIST HAS THREE DIFFERENT CAUSES AND THEY MUST NOT READ ALIKE. There is nothing queued;
 * there is plenty queued but the filter excluded it; and — the one that misled on the first run —
 * everything queued has already been RULED ON and is waiting on the app's next drain. Reporting
 * that third case as "the queue is empty" while the same screen says "from 4 queue rows" is the
 * defect the 2026-09-09 commit fixed for the review tab; it must not come back through this door.
 */
export function renderQueue(decisions: Decision[], total: number, limit = 10, settled = 0): string {
  if (decisions.length === 0) {
    if (total > 0) {
      return `No decision matched the filter. ${total} decision(s) exist unfiltered, so this is a narrow view, not an empty queue.`;
    }
    return settled > 0
      ? `Nothing is waiting on you. ${settled} decision(s) already carry a verdict and are waiting on the app's next drain to be applied.`
      : 'The queue is empty — nothing is waiting on a person.';
  }
  const lines: string[] = [
    `${decisions.length} decision(s) awaiting a verdict, highest consequence first.`,
    '',
  ];
  for (const d of decisions.slice(0, limit)) {
    const marks = [
      d.escalate ? 'ESCALATION' : d.contested ? `${d.claims.length} CLAIMS` : '',
      d.kind === 'batch' ? `BATCH of ${d.claims.length}` : '',
      d.priority === 'high' ? 'HIGH' : '',
      d.open ? 'UNANSWERED' : '',
    ].filter(Boolean).join(' · ');
    lines.push(`${d.id}  ${oneLine(d.question, 96)}`);
    lines.push(`        ${shortName(d.subject)} ${shortName(d.predicate)}${marks ? `  ·  ${marks}` : ''}`);
  }
  if (decisions.length > limit) {
    lines.push('');
    lines.push(`… and ${decisions.length - limit} more. The tail is ranked lowest for a reason; it is not hidden.`);
  }
  return lines.join('\n');
}

// ── Recording a verdict ─────────────────────────────────────────────────────

export class ReviewRefusal extends Error {}

export interface DecideInput {
  decision: Decision;
  verdict: VerdictKind;
  claim?: string;
  note?: string;
  /** Observed identity from actor.ts. Never a string the caller chose. */
  actor: Actor;
  now?: string;
}

/**
 * Build the verdict, refusing every case a terminal must not settle.
 *
 * REFUSALS ARE THE POINT OF THIS FUNCTION. It would be a one-line object literal without them,
 * and each refusal below corresponds to a way a terminal verdict could quietly destroy something
 * a person meant to keep.
 */
export function buildVerdict(input: DecideInput): Verdict {
  const { decision: d, verdict, claim, note, actor } = input;

  if (d.escalate && (verdict === 'accept' || verdict === 'reject')) {
    throw new ReviewRefusal(
      `${d.id} is a contest between two human-attested claims. A terminal cannot settle that — `
      + `accepting one here would overrule a person with a command, with no record of the argument. `
      + `Open the app and use a Reckoning. \`defer\` is allowed and records why you stopped.`,
    );
  }

  if (verdict === 'accept') {
    if (d.claims.length === 0) {
      throw new ReviewRefusal(
        `${d.id} has no claim to accept — it is an open question with nothing proposed. `
        + `Supplying the answer needs the partial-fact picker in the app (F32).`,
      );
    }
    /*
     * `all` takes an entire BATCH, and is refused on a choice. On a batch the claims do not
     * compete, so accepting the set destroys nothing; on a choice it would mean confirming several
     * incompatible values at once, which is not a verdict but a contradiction.
     */
    if (claim === 'all') {
      if (d.kind === 'choice') {
        throw new ReviewRefusal(
          `${d.id} is a CHOICE — its ${d.claims.length} claims cannot all be true, so \`all\` is not a `
          + `verdict. Name one: ${d.claims.map((c) => c.id).join(', ')}.`,
        );
      }
      return {
        decision: d.id, verdict: 'accept', claim: 'all',
        rows: d.rowIds, subject: d.subject, predicate: d.predicate,
        objects: d.claims.map((c) => c.object), kb: d.kb, supersedes: [], note, actor,
        at: input.now ?? new Date().toISOString(),
      };
    }

    if (!claim && d.claims.length > 1) {
      throw new ReviewRefusal(
        d.kind === 'choice'
          ? `${d.id} has ${d.claims.length} competing claims and no claim id was given. `
            + `Accepting without choosing would pick one arbitrarily and supersede the rest. `
            + `Claims: ${d.claims.map((c) => c.id).join(', ')}.`
          : `${d.id} holds ${d.claims.length} independent proposals. Name one claim, or \`all\` to `
            + `take the set. Claims: ${d.claims.map((c) => c.id).join(', ')}.`,
      );
    }
    const chosen = claim ? d.claims.find((c) => c.id === claim || c.id.endsWith(`.${claim}`)) : d.claims[0];
    if (!chosen) {
      throw new ReviewRefusal(
        `${d.id} has no claim ${claim}. Known claims: ${d.claims.map((c) => c.id).join(', ')}.`,
      );
    }
    /*
     * WHAT ACCEPTING KILLS, STATED IN THE RECORD ITSELF rather than re-derived by whoever applies
     * it. A choice supersedes its rivals; a batch supersedes nothing. Writing the list here means
     * the app does not have to reconstruct the arity measurement to know what a verdict meant, and
     * a reader of the journal can see the blast radius of a decision without the queue beside it.
     */
    return {
      decision: d.id, verdict: 'accept', claim: chosen.id,
      rows: d.rowIds, subject: d.subject, predicate: d.predicate,
      object: chosen.object, kb: d.kb,
      supersedes: d.kind === 'choice' ? d.claims.filter((c) => c.id !== chosen.id).map((c) => c.object) : [],
      note, actor,
      at: input.now ?? new Date().toISOString(),
    };
  }

  return {
    decision: d.id, verdict,
    rows: d.rowIds, subject: d.subject, predicate: d.predicate, kb: d.kb,
    note, actor, at: input.now ?? new Date().toISOString(),
  };
}

/**
 * Append verdicts to the journal under the same lock the queue uses.
 *
 * Shares transactPendingFile's `<path>.lock` protocol so a verdict written while an offline job is
 * appending findings cannot interleave into a torn line.
 */
export function recordVerdicts(file: string, verdicts: Verdict[]): void {
  appendPendingLines(file, verdicts.map((v) => JSON.stringify(v)));
}

/** What a person should be told after a verdict lands. Says what has NOT happened yet. */
export function renderVerdict(v: Verdict, d: Decision): string {
  const lines: string[] = [];
  if (v.verdict === 'accept') {
    if (v.claim === 'all') {
      lines.push(`RECORDED: accept all ${v.objects?.length ?? 0} proposal(s) on ${d.id}`);
      lines.push('  Nothing is superseded — these claims never competed.');
    } else {
      lines.push(`RECORDED: accept ${v.claim} — ${v.object}`);
      const superseded = v.supersedes ?? [];
      if (superseded.length > 0) {
        lines.push(`  ${superseded.length} competing claim(s) will be marked superseded, not deleted:`);
        for (const o of superseded) lines.push(`    ${o}`);
      } else if (d.kind === 'batch') {
        lines.push(`  The other ${d.claims.length - 1} proposal(s) are untouched and still awaiting review.`);
      }
    }
  } else {
    lines.push(`RECORDED: ${v.verdict} ${d.id}`);
  }
  if (v.note) lines.push(`  note: ${v.note}`);
  lines.push('');
  lines.push(`Journalled to ${DECISIONS_FILE}: ${actorLine(v.actor)}`);
  lines.push(`  ${v.actor.attestation}`);
  lines.push('NOTHING HAS CHANGED IN THE GRAPH YET — the app applies this on its next drain.');
  return lines.join('\n');
}
