/**
 * THE HIERARCHICAL REVIEW TREE (F139) — decisions at the top, the case for them underneath,
 * the bookkeeping behind a number.
 *
 * Matt, 2026-08-19: "We need to nail this review process or Reckons.AI is just a shitty graph
 * engine. This is about collaborative knowledge refinement... We need to be able to hide the
 * noise and focus on the critical deciding factors."
 *
 * WHAT WAS ALREADY BUILT, AND WHY IT WAS NOT ENOUGH. review-pipeline.ts composes four real
 * stages — dedupe (F80.1), route by competence (F88), spotlight the contested (F53), group into
 * entity cards (F83). Every one of them is a FLAT transform: it filters, ranks, or buckets rows.
 * None of them can express that one fact is the REASON for another. So the surface could get
 * shorter but never deeper, and a shorter flat list still presents a measurement and the
 * decision it supports as two peers competing for the same click.
 *
 * THE TREE IS THE MISSING RELATION: `is the case for`. Its depth is the altitude ladder
 * (fact-altitude.ts), because altitude is defined by what happens if a fact is WRONG, and that
 * is exactly the relation "supports" needs:
 *
 *   DECISION      the open question                       ← the only thing shown by default
 *     OPTION      a way it could go, with its real cost
 *       JUDGMENT  a verdict bearing on that option
 *         EVIDENCE  the measurement under the verdict
 *           ⌄ n records + logs                            ← a count, openable, never a row
 *
 * THREE RULES THIS ENCODES, EACH OF WHICH THE FLAT QUEUE GOT WRONG:
 *
 * 1. AN OPTION'S COST IS COMPUTED, NEVER NARRATED. static/starter-everyday.ttl already got this
 *    right and nothing in src/ ever read it: `kpred:ruled-out-by kb:lake-george` marks a fact
 *    that DIES if that option wins. So "what does this option cost" is a graph query, not an
 *    LLM's opinion — see optionCost(). A model may PHRASE a tradeoff; it may never invent one.
 *
 * 2. A SETTLED DECISION IS CONTEXT, NOT AN ITEM. `kpred:decided` and `kpred:open-question` are
 *    both decision-altitude, and showing them alike is how a review surface re-asks in August
 *    what was answered in March. Settled decisions render as the standing frame around the open
 *    one; only open items are countable work.
 *
 * 3. TWO HUMAN OPINIONS IN CONFLICT ARE NOT AN ACCEPT/REJECT. Accept/reject asks the person to
 *    declare a past position of their own wrong, with no reasoning captured and nothing left
 *    behind explaining why. That is what escalate === 'stp' is for: the conflict becomes the
 *    Situation of a Reckoning, and the output is a Decision entity that supersedes both sides
 *    AND records the reasoning. See needsStp().
 *
 * PURE. This reads a graph and plans a review; it settles nothing, writes nothing, and calls no
 * model. Distillation is requested from it (distillationRequest) and applied to it as a LABEL,
 * never merged into it as a fact — see the warning on DistilledLine.
 */
import type { Statement } from './types';
import { isLit, isIRI } from './types';
import {
  altitudeOf, reviewAltitude, isOpenDecision, ALTITUDE_RANK, type Altitude,
} from './fact-altitude';
import { gateFor } from './verifiability';
import { findDichotomies } from './dichotomy';
import { blastRadius } from './review-routing';
import { labelFromIRI } from './semantic-diff';
import { isPendingReview } from './entity-review';

const KPRED = 'urn:kbase:predicate/';
const RULED_OUT_BY = `${KPRED}ruled-out-by`;
const DECIDES = `${KPRED}decides`;
const DEPENDS_ON = `${KPRED}depends-on`;
const HAS_STATUS = `${KPRED}has-status`;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/**
 * A distilled line — an LLM's phrasing of the facts beneath it.
 *
 * ⚠ THIS IS NOT A FACT AND MUST NEVER BECOME ONE. It carries no id, no status, no provenance,
 * and it is regenerated on demand rather than stored. The moment a summary is written back into
 * the graph it becomes citable, and then a model's paraphrase is indistinguishable from a
 * measurement — which is the precise laundering the project thesis exists to prevent (an
 * unverifiable claim, made by the party it benefits, is not evidence). The facts it summarizes
 * are always listed beneath it and always openable; if the two disagree, the facts win.
 */
export interface DistilledLine {
  /** The model's one-line phrasing. Display only. */
  text: string;
  /** The statement ids it was derived from — every one of them, so it can be checked. */
  from: string[];
  /** Which model produced it, so a bad distillation is traceable to its source. */
  by: string;
}

export interface OptionNode {
  iri: string;
  label: string;
  /**
   * The facts this option KILLS — computed from `kpred:ruled-out-by`. This is the option's price,
   * stated in the graph's own terms rather than in prose.
   */
  rulesOut: Statement[];
  /** Facts asserted about the option itself (its elevation, its price, its evidence). */
  describedBy: Statement[];
  /** Set only when a distillation has been requested and returned. Never persisted. */
  distilled?: DistilledLine;
}

export type Escalation = 'stp' | null;

export interface DecisionNode {
  subjectIri: string;
  label: string;
  /** The open decision fact — the question itself. */
  question: Statement;
  /**
   * True when the question is PROSE ONLY: a `kpred:open-question` literal with no Option entities
   * behind it. Measured 2026-08-19: this is 100% of the roadmap's 77 open decisions, so the tree
   * must render this case honestly rather than pretending options exist. Structuring it is the
   * agent-tier distillation job, and it emits proposals a human gates.
   */
  proseOnly: boolean;
  options: OptionNode[];
  /** Standing decisions already made on this subject — the frame, not the work. */
  standing: Statement[];
  /** Qualitative verdicts bearing on the decision. */
  judgments: Statement[];
  /** Measurements under those verdicts. */
  evidence: Statement[];
  /** Records + logs on this subject: a count and a drawer, never rows. */
  hidden: Statement[];
  /** One entity, two incompatible values (dichotomy.ts, kind 'conflict'). */
  contested: boolean;
  /**
   * 'stp' when the conflict is between two HUMAN-ATTESTED claims. Accept/reject is the wrong
   * control for that; it needs a Reckoning. Null otherwise.
   */
  escalate: Escalation;
  /** A forcing event: something with `kpred:decides` pointing at this subject (e.g. a deadline). */
  forcedBy: Statement[];
  /**
   * Set when this root exists because of a CONFLICT rather than a written question.
   *
   * A defect found by the F139 demo graph on 2026-08-19 and worth stating plainly: roots were open
   * decisions only, so a contested entity carrying no `kpred:open-question` never appeared in the
   * tree at all — it fell into the orphan tail. That is incoherent with this file's own ranking rule
   * that contested outranks everything: the strongest review signal in the system could only be seen
   * if the entity happened to also have a question written on it.
   *
   * A CONFLICT IS A DECISION THE GRAPH NEVER WROTE DOWN. It is the same shape as the camping graph
   * that prices both options and states no question — the decision point is implied by facts that
   * cannot both stand, so the tree synthesizes the root rather than waiting for someone to author it.
   */
  impliedBy?: 'conflict';
  /** For an implied root: the incompatible values, so the question can name them. */
  conflictValues?: string[];
  /** Transitive blast radius from review-routing — how much is stalled behind this. */
  impact: number;
  /** Entities that transitively depend on this subject — what settling it releases (unlockCounts). */
  unlocks: number;
  /** The subject's lifecycle status, when it has one. Drives urgency. */
  status?: string;
  distilled?: DistilledLine;
}

export interface ReviewTree {
  /** The open decisions, ranked. This is the whole review surface. */
  decisions: DecisionNode[];
  /** Facts that never reach a person: record + log altitude, outside any decision. */
  suppressed: { record: number; log: number };
  /**
   * PENDING judgment/evidence facts that hang off no open decision.
   *
   * Matt, 2026-08-19, correcting an earlier version of this design: the tail is not one
   * population. "Some may be missing a true decision to make. Some may already be verified by
   * code and tests, or available existing facts and ingested resources. We do NOT want to
   * represent the user with hundreds of separate 'facts' that are just log lines tracing work
   * completion." So the three kinds are separated here rather than lumped: log-shaped narration
   * is demoted by fact-altitude.ts and lands in `suppressed`; anything a check could settle
   * leaves via `machineSettleable`; what remains in `orphans` is genuinely qualitative with no
   * decision above it — the only population worth clustering into a missing decision.
   */
  orphans: Statement[];
  /**
   * Facts a check could settle rather than a person — F88's machine lane, kept OUT of orphans.
   *
   * MEASURED LIMIT, 2026-08-19: on the roadmap this catches only 7 of 1,646, because
   * inferVerifiability returns `unknown` for ~95% of facts and unknown fails toward the human.
   * The population Matt describes is real; the classifier cannot find it yet, and F135.2 (nothing
   * writes Statement.verifiableBy anywhere in src/) is the reason. Do not read a small number here
   * as evidence that few facts are machine-settleable.
   */
  machineSettleable: Statement[];
  /**
   * SETTLED facts with no open decision above them — the graph's standing description.
   *
   * NOT A REVIEW LANE AND NOT A BACKLOG. A confirmed `kpred:description` on a shipped feature is
   * what the feature IS; it is read by navigating to the entity, and it costs nothing to review
   * because it is not under review. Counting these as pending work is what made an earlier version
   * of this design report 1,641 outstanding items on a graph with no outstanding items at all.
   */
  standingDescription: number;
  /** Total facts considered, for the honest headline. */
  considered: number;
}

/** Facts that die if `optionIri` wins. The option's cost, computed. */
export function optionCost(optionIri: string, all: Statement[]): Statement[] {
  return all.filter((st) => st.p.value === RULED_OUT_BY && st.o.value === optionIri);
}

/**
 * Options for a decision subject: every distinct entity named by a `ruled-out-by` on facts that
 * belong to this decision's subtree.
 *
 * Deliberately derived rather than declared. `kpred:ruled-out-by` already exists in real data;
 * a new `kpred:option` predicate would need every existing graph rewritten before the tree could
 * show anything. Reading the relation that is already there means the everyday camping graph and
 * the roadmap both work today.
 */
export function optionsFor(subjectIri: string, all: Statement[], index?: GraphIndex): OptionNode[] {
  const idx = index ?? buildGraphIndex(all);

  // One hop: this subject, plus anything that points at it (its parts, its events).
  const scope = new Set<string>([subjectIri, ...(idx.subjectsByObject.get(subjectIri) ?? [])]);

  const optionIris = new Set<string>();
  for (const [optionIri, killed] of idx.ruledOutBy) {
    if (killed.some((st) => scope.has(st.s.value))) optionIris.add(optionIri);
  }

  return [...optionIris].sort().map((iri) => ({
    iri,
    label: idx.labels.get(iri) ?? labelFromIRI(iri),
    rulesOut: idx.ruledOutBy.get(iri) ?? [],
    describedBy: idx.describedBy.get(iri) ?? [],
  }));
}

function labelOf(iri: string, all: Statement[], index?: GraphIndex): string {
  if (index) return index.labels.get(iri) ?? labelFromIRI(iri);
  const l = all.find((st) => st.s.value === iri && st.p.value === RDFS_LABEL && isLit(st.o));
  return l ? l.o.value : labelFromIRI(iri);
}

/**
 * Is this conflict one that must go to STP rather than accept/reject?
 *
 * The test is WHOSE CLAIMS collide. Two machine-checkable values disagreeing is a bug: run the
 * check, the graph loses. Two HUMAN-ATTESTED values disagreeing is a genuine change of mind or a
 * genuine disagreement between people, and there is no check that adjudicates it — so the useful
 * output is not "which row survives" but the REASONING, which only a structured Situation-Target-
 * Proposal captures. Rejecting one row throws that reasoning away and the same conflict returns.
 */
export function needsStp(sides: Statement[], typeOf?: (iri: string) => string | undefined): boolean {
  if (sides.length < 2) return false;
  return sides.every((st) => gateFor(st, typeOf?.(st.s.value)) === 'user');
}

/**
 * How urgent is a question about work at this lifecycle stage?
 *
 * A cheap, honest signal, and it fixes a real failure observed the first time the tree ran on the
 * roadmap: the top six roots were speculative notes about NVIDIA models and FiftyOne, ranked above
 * every live decision, because nothing else in the ranking had any signal on that graph. A question
 * about work that is IN PROGRESS blocks somebody today; the same question about `speculative` work
 * blocks nobody. Unknown status sits in the middle rather than at either extreme — absence of a
 * status is not evidence of unimportance.
 */
const STATUS_URGENCY: Record<string, number> = {
  'in-progress': 5,
  scaffolded: 4,
  planned: 3,
  functional: 2,
  production: 1,
  speculative: 0,
};
const DEFAULT_URGENCY = 2.5;

/**
 * How many entities transitively DEPEND on each subject — what settling it releases.
 *
 * The `blocks` field was supposed to carry this and does not: queue-tree.ts measured only 8 of 529
 * queue rows carrying it, so blastRadius() has almost nothing to walk and every decision looks
 * equally urgent. But the relation is not missing, it is just somewhere else — the roadmap states
 * 140 `kpred:depends-on` edges. So project the ranking from the plan the graph already holds
 * instead of waiting for a field nobody fills in.
 *
 * Cycles are visited once and not re-entered: a dependency cycle means the work is deadlocked,
 * which a count must not paper over by spinning.
 */
export function unlockCounts(all: Statement[]): Map<string, number> {
  /** subject -> the entities that need it. */
  const neededBy = new Map<string, string[]>();
  for (const st of all) {
    if (st.p.value !== DEPENDS_ON || !isIRI(st.o)) continue;
    const list = neededBy.get(st.o.value);
    if (list) list.push(st.s.value);
    else neededBy.set(st.o.value, [st.s.value]);
  }

  /*
   * ONE MEMOIZED CLOSURE, NOT TWO MUTUALLY-RECURSIVE WALKS.
   *
   * The first version had a memoized `reach` calling an UNMEMOIZED `collect`, which re-walked every
   * shared subtree from scratch on each visit — exponential on a dependency graph where several
   * features depend on the same foundation, which is exactly the shape a real roadmap has. It also
   * memoized counts computed while a cycle cut was active, caching a truncated answer as if it were
   * final. Both are fixed by computing the closure once per node and caching the SET.
   *
   * HONEST LIMIT ON CYCLES: a back-edge contributes nothing, so a node inside a dependency cycle
   * gets a LOWER BOUND rather than a true count. That is deliberate and matches blastRadius: a cycle
   * means the work is deadlocked, and a count must not paper over that by spinning.
   */
  const closure = new Map<string, Set<string>>();
  const inProgress = new Set<string>();

  function closureOf(iri: string): Set<string> {
    const hit = closure.get(iri);
    if (hit) return hit;
    if (inProgress.has(iri)) return new Set();
    inProgress.add(iri);
    const out = new Set<string>();
    for (const dependant of neededBy.get(iri) ?? []) {
      out.add(dependant);
      for (const further of closureOf(dependant)) out.add(further);
    }
    inProgress.delete(iri);
    closure.set(iri, out);
    return out;
  }

  const counts = new Map<string, number>();
  for (const iri of neededBy.keys()) counts.set(iri, closureOf(iri).size);
  return counts;
}

/**
 * Precomputed indexes over the whole graph, so the per-decision work stays linear.
 *
 * Built ONCE in buildReviewTree and threaded through. Without it optionsFor scans `all` twice per
 * decision plus once per option — on a 4,000-fact graph with 79 open decisions that is millions of
 * iterations on the main thread every time the derived state recomputes, which is exactly how a
 * review page becomes unresponsive.
 */
export interface GraphIndex {
  /** object IRI -> subjects that point at it, for one-hop scope expansion. */
  subjectsByObject: Map<string, string[]>;
  /** option IRI -> the facts it rules out. */
  ruledOutBy: Map<string, Statement[]>;
  /** subject IRI -> its rdfs:label literal. */
  labels: Map<string, string>;
  /** subject IRI -> its facts at evidence altitude or above, for option descriptions. */
  describedBy: Map<string, Statement[]>;
}

export function buildGraphIndex(all: Statement[]): GraphIndex {
  const subjectsByObject = new Map<string, string[]>();
  const ruledOutBy = new Map<string, Statement[]>();
  const labels = new Map<string, string>();
  const describedBy = new Map<string, Statement[]>();

  for (const st of all) {
    if (isIRI(st.o)) {
      const list = subjectsByObject.get(st.o.value);
      if (list) list.push(st.s.value);
      else subjectsByObject.set(st.o.value, [st.s.value]);
    }
    if (st.p.value === RULED_OUT_BY) {
      const list = ruledOutBy.get(st.o.value);
      if (list) list.push(st);
      else ruledOutBy.set(st.o.value, [st]);
    }
    if (st.p.value === RDFS_LABEL && isLit(st.o) && !labels.has(st.s.value)) {
      labels.set(st.s.value, st.o.value);
    }
    if (ALTITUDE_RANK[altitudeOf(st)] >= ALTITUDE_RANK.evidence) {
      const list = describedBy.get(st.s.value);
      if (list) list.push(st);
      else describedBy.set(st.s.value, [st]);
    }
  }

  return { subjectsByObject, ruledOutBy, labels, describedBy };
}

export interface ReviewTreeOptions {
  typeOf?: (subjectIri: string) => string | undefined;
  /** Cap on decision roots returned. The rest are ranked below, not hidden — see heldBack. */
  maxDecisions?: number;
}

/**
 * Build the tree from a pending set, read against the whole graph.
 *
 * `pending` supplies the live items; `all` supplies the case for them — the evidence, the
 * standing decisions and the option costs mostly live in CONFIRMED facts, so a tree built from
 * the pending slice alone would show questions with nothing underneath.
 */
export function buildReviewTree(
  pending: Statement[],
  all: Statement[] = pending,
  opts: ReviewTreeOptions = {},
): ReviewTree {
  const typeOf = opts.typeOf ?? (() => undefined);
  const impacts = blastRadius(pending);
  const unlocks = unlockCounts(all);
  // Built once. See GraphIndex — without this the per-decision work is quadratic in the graph.
  const index = buildGraphIndex(all);
  const statusOf = new Map<string, string>();
  for (const st of all) if (st.p.value === HAS_STATUS && isLit(st.o)) statusOf.set(st.s.value, st.o.value);

  // Conflicts, keyed by subject, so a decision node can say it is contested.
  // findDichotomies reports the entity, the predicate and the divergent VALUES; the STP test
  // needs the STATEMENTS, because it turns on who is competent to settle each side. So resolve
  // them back rather than re-implementing the detection.
  const conflictSides = new Map<string, Statement[]>();
  for (const d of findDichotomies(all)) {
    if (d.kind !== 'conflict') continue;
    const sides = all.filter(
      (st) => st.s.value === d.entityIri && st.p.value === d.predicate && d.values.includes(st.o.value),
    );
    const prev = conflictSides.get(d.entityIri);
    if (prev) prev.push(...sides);
    else conflictSides.set(d.entityIri, sides);
  }

  const bySubject = new Map<string, Statement[]>();
  for (const st of all) {
    const g = bySubject.get(st.s.value);
    if (g) g.push(st);
    else bySubject.set(st.s.value, [st]);
  }

  const openBySubject = new Map<string, Statement[]>();
  for (const st of pending) {
    // A settled fact is never a review item, however open its question reads. The tree filters
    // here rather than trusting the caller: passing a whole confirmed graph in as `pending` is an
    // easy mistake and it silently turns the graph's standing description into a fake backlog.
    if (!isPendingReview(st)) continue;
    if (!isOpenDecision(st)) continue;
    const g = openBySubject.get(st.s.value);
    if (g) g.push(st);
    else openBySubject.set(st.s.value, [st]);
  }

  /** subject IRI -> forcing events (kpred:decides pointing at it). One pass, not one per decision. */
  const forcedByIndex = new Map<string, Statement[]>();
  for (const st of all) {
    if (st.p.value !== DECIDES) continue;
    const list = forcedByIndex.get(st.o.value);
    if (list) list.push(st);
    else forcedByIndex.set(st.o.value, [st]);
  }

  const decisions: DecisionNode[] = [];
  const attached = new Set<string>();

  for (const [subjectIri, questions] of openBySubject) {
    const siblings = bySubject.get(subjectIri) ?? [];
    const options = optionsFor(subjectIri, all, index);
    const sides = conflictSides.get(subjectIri) ?? [];

    const standing: Statement[] = [];
    const judgments: Statement[] = [];
    const evidence: Statement[] = [];
    const hidden: Statement[] = [];

    for (const st of siblings) {
      if (questions.some((q) => q.id === st.id)) continue;
      attached.add(st.id);
      const alt = reviewAltitude(st, typeOf(subjectIri));
      if (alt === 'decision') standing.push(st);
      else if (alt === 'judgment') judgments.push(st);
      else if (alt === 'evidence') evidence.push(st);
      else hidden.push(st);
    }

    for (const q of questions) {
      attached.add(q.id);
      decisions.push({
        subjectIri,
        label: labelOf(subjectIri, all, index),
        question: q,
        proseOnly: options.length === 0,
        options,
        standing,
        judgments,
        evidence,
        hidden,
        contested: sides.length > 1,
        escalate: sides.length > 1 && needsStp(sides, typeOf) ? 'stp' : null,
        forcedBy: forcedByIndex.get(subjectIri) ?? [],
        impact: impacts.get(q.id) ?? 0,
        unlocks: unlocks.get(subjectIri) ?? 0,
        status: statusOf.get(subjectIri),
      });
    }
  }

  /*
   * IMPLIED ROOTS — contested subjects that nobody wrote a question for.
   *
   * Added after the authored roots so an entity carrying BOTH a conflict and an open question keeps
   * its real question and is merely flagged contested; only a subject with no question of its own
   * gets a synthesized one.
   */
  for (const [subjectIri, sides] of conflictSides) {
    if (sides.length < 2) continue;
    if (openBySubject.has(subjectIri)) continue;
    // Only surface a conflict the human is competent to settle; a machine-checkable clash is a bug
    // to fix by running the check, not a decision to put to a person.
    if (!needsStp(sides, typeOf)) continue;

    const siblings = bySubject.get(subjectIri) ?? [];
    const standing: Statement[] = [];
    const judgments: Statement[] = [];
    const evidence: Statement[] = [];
    const hidden: Statement[] = [];
    for (const st of siblings) {
      attached.add(st.id);
      const alt = reviewAltitude(st, typeOf(subjectIri));
      if (alt === 'decision') standing.push(st);
      else if (alt === 'judgment') judgments.push(st);
      else if (alt === 'evidence') evidence.push(st);
      else hidden.push(st);
    }

    // The anchor is the OLDEST conflicting side: it is the claim that has stood longest unchallenged,
    // which makes it the honest thing to question rather than the newest arrival.
    const anchor = [...sides].sort((a, b) => a.createdAt - b.createdAt)[0];
    decisions.push({
      subjectIri,
      label: labelOf(subjectIri, all, index),
      question: anchor,
      proseOnly: true,
      options: optionsFor(subjectIri, all, index),
      standing,
      judgments,
      evidence,
      hidden,
      contested: true,
      escalate: 'stp',
      forcedBy: forcedByIndex.get(subjectIri) ?? [],
      impact: impacts.get(anchor.id) ?? 0,
      unlocks: unlocks.get(subjectIri) ?? 0,
      status: statusOf.get(subjectIri),
      impliedBy: 'conflict',
      conflictValues: [...new Set(sides.map((st) => st.o.value))],
    });
  }

  /**
   * Ranking, most consequential first.
   *
   * CONTESTED OUTRANKS EVERYTHING — a live disagreement is the one thing that must never be
   * buried, and it is the only signal strong enough to be lexicographic rather than weighted.
   * A forced decision (something with a deadline pointing at it) comes next for the same reason:
   * the deadline decides it if nobody else does.
   *
   * Below those, the signals are WEIGHTED rather than ordered, because on a real graph any single
   * one of them is often flat. `impact` is near-useless today (the `blocks` field is filled in on
   * a handful of rows), `unlocks` carries the roadmap's 140 dependency edges, and status urgency
   * separates live work from speculation. Summing them means a decision needs only one real signal
   * to surface, instead of being sorted by whichever field happens to be populated.
   */
  const weight = (d: DecisionNode) =>
    d.impact * 2 + d.unlocks * 3 + (STATUS_URGENCY[d.status ?? ''] ?? DEFAULT_URGENCY) + d.options.length;

  decisions.sort(
    (a, b) =>
      Number(b.contested) - Number(a.contested) ||
      Number(b.forcedBy.length > 0) - Number(a.forcedBy.length > 0) ||
      weight(b) - weight(a) ||
      a.question.createdAt - b.question.createdAt ||
      a.subjectIri.localeCompare(b.subjectIri),
  );

  const suppressed = { record: 0, log: 0 };
  const orphans: Statement[] = [];
  const machineSettleable: Statement[] = [];
  let standingDescription = 0;

  for (const st of pending) {
    if (attached.has(st.id)) continue;

    // Settled and under no open decision: the standing description of the system. Not work.
    if (!isPendingReview(st)) {
      standingDescription++;
      continue;
    }

    const alt = reviewAltitude(st, typeOf(st.s.value));
    if (alt === 'record') { suppressed.record++; continue; }
    if (alt === 'log') { suppressed.log++; continue; }

    // A check settles it, so it is not the human's orphan — it is the machine lane's work.
    if (gateFor(st, typeOf(st.s.value)) === 'machine') { machineSettleable.push(st); continue; }

    orphans.push(st);
  }

  const capped = opts.maxDecisions ? decisions.slice(0, opts.maxDecisions) : decisions;
  return { decisions: capped, suppressed, orphans, machineSettleable, standingDescription, considered: pending.length };
}

/**
 * The grounding payload for an agent-tier distillation, and the reason it can be trusted.
 *
 * The model is handed ONLY facts that are already in the graph and asked for a phrasing. It is
 * never asked what the options are, because 35 of the roadmap's 58 open-question literals already
 * state their alternatives IN THE PROSE — the alternatives are present and merely unstructured,
 * so structuring them is reading, not inventing. Anything the model returns that does not trace
 * back to `sourceIds` is rejected by the harness rather than queued.
 */
export interface DistillationRequest {
  subjectIri: string;
  /** The question literal, verbatim. */
  question: string;
  /** Facts the phrasing may draw on — nothing else is in scope. */
  facts: Array<{ id: string; predicate: string; object: string }>;
  sourceIds: string[];
  /** What the model is for: phrasing, not judgment. */
  task: 'phrase-tradeoff' | 'structure-options';
}

export function distillationRequest(node: DecisionNode): DistillationRequest {
  const facts = [...node.judgments, ...node.evidence, ...node.standing].map((st) => ({
    id: st.id,
    predicate: st.p.value.replace(KPRED, 'kpred:'),
    object: st.o.value,
  }));
  return {
    subjectIri: node.subjectIri,
    question: isLit(node.question.o) ? node.question.o.value : (node.question.question ?? ''),
    facts,
    sourceIds: facts.map((f) => f.id),
    task: node.proseOnly ? 'structure-options' : 'phrase-tradeoff',
  };
}

/**
 * The question a root asks, as text.
 *
 * For an authored root that is the literal. For an IMPLIED root there is no literal, so it is
 * composed from the incompatible values — and it is composed at READ TIME rather than written into
 * the graph, because the graph should not gain a question nobody asked.
 */
export function questionText(node: DecisionNode): string {
  if (node.impliedBy === 'conflict') {
    const vals = (node.conflictValues ?? []).map((v) => `"${v}"`).join(' or ');
    const pred = node.question.p.value.replace(KPRED, '');
    return `Nobody wrote this question down, but two facts disagree: ${pred} is ${vals}. Which holds?`;
  }
  return isLit(node.question.o) ? node.question.o.value : (node.question.question ?? '');
}

/** The honest headline: what a person is actually being asked to do. */
export function reviewTreeSummary(tree: ReviewTree): string {
  const n = tree.decisions.length;
  const quiet = tree.suppressed.record + tree.suppressed.log;
  if (n === 0) {
    const bits: string[] = [];
    if (quiet) bits.push(`${quiet} bookkeeping fact${quiet === 1 ? '' : 's'} settled without you`);
    if (tree.orphans.length) bits.push(`${tree.orphans.length} judgment${tree.orphans.length === 1 ? '' : 's'} under no decision`);
    return bits.length ? `No decisions open. ${bits.join('; ')}.` : 'No decisions open.';
  }
  const contested = tree.decisions.filter((d) => d.contested).length;
  const stp = tree.decisions.filter((d) => d.escalate === 'stp').length;
  const implied = tree.decisions.filter((d) => d.impliedBy === 'conflict').length;
  const prose = tree.decisions.filter((d) => d.proseOnly && !d.impliedBy).length;
  const parts = [`${n} decision${n === 1 ? '' : 's'} open`];
  if (implied) parts.push(`${implied} implied by a conflict nobody wrote down`);
  if (contested) parts.push(`${contested} contested${stp ? ` (${stp} needing a reckoning)` : ''}`);
  if (prose) parts.push(`${prose} still prose-only — no options to weigh yet`);
  if (quiet) parts.push(`${quiet} bookkeeping fact${quiet === 1 ? '' : 's'} never shown`);
  if (tree.machineSettleable.length) parts.push(`${tree.machineSettleable.length} a check can settle`);
  if (tree.orphans.length) parts.push(`${tree.orphans.length} judgment${tree.orphans.length === 1 ? '' : 's'} under no decision`);
  return `${parts.join('; ')}.`;
}
