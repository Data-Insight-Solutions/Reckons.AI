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
   * Subject IRIs of OTHER OPEN DECISIONS that should be settled first, because this decision's
   * subject transitively `depends-on` theirs.
   *
   * Projected from the roadmap's own 140 `kpred:depends-on` edges rather than from
   * `Statement.blocks`, which was supposed to carry this and does not — queue-tree.ts measured
   * only 8 of 529 rows carrying it. The relations were never missing, they were just held at
   * FEATURE level while the queue asked at FACT level. Deciding a feature whose foundation is
   * still undecided is how you end up revisiting it.
   */
  blockedBy: string[];
  /** True when this decision sits inside a dependency CYCLE, so its ordering is a lower bound. */
  inCycle: boolean;
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
  /**
   * The conflicting statements themselves, not just their values.
   *
   * Exposed because a reader cannot ACT on a conflict from values alone. Without these the review
   * surface could only describe the disagreement and then make the user resolve it fact-by-fact in
   * the flat list below — accept one, meet the other as a fresh conflict, decide again. That second
   * decision is redundant: picking a side IS rejecting the other, and it should be one action.
   */
  conflictSides?: Statement[];
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
type DependencyGraph = {
  nodes: string[];
  indexOf: Map<string, number>;
  adjacency: number[][];
  componentOf: Int32Array;
  components: number[][];
  componentDag: number[][];
  topologicalComponents: number[];
  cyclicComponents: Uint8Array;
};

/**
 * Condense a directed graph into strongly-connected components without recursion.
 *
 * Dependency imports can contain long chains, so recursive Tarjan/Kosaraju walks are themselves a
 * stack-overflow risk. The two iterative Kosaraju passes below visit each node and edge once. The
 * resulting component graph is a DAG: every member of a component has the same outside closure,
 * while a multi-node component (or a self-loop) is exactly a dependency cycle.
 */
function buildDependencyGraph(edges: readonly (readonly [string, string])[]): DependencyGraph {
  const nodes: string[] = [];
  const indexOf = new Map<string, number>();
  const outgoing: Array<Set<number>> = [];

  const nodeIndex = (iri: string): number => {
    const prior = indexOf.get(iri);
    if (prior !== undefined) return prior;
    const index = nodes.length;
    nodes.push(iri);
    indexOf.set(iri, index);
    outgoing.push(new Set());
    return index;
  };

  for (const [fromIri, toIri] of edges) {
    const from = nodeIndex(fromIri);
    const to = nodeIndex(toIri);
    outgoing[from].add(to);
  }

  const adjacency = outgoing.map((targets) => [...targets]);
  const reverse = Array.from({ length: nodes.length }, () => [] as number[]);
  for (let from = 0; from < adjacency.length; from++) {
    for (const to of adjacency[from]) reverse[to].push(from);
  }

  // First pass: finishing order in the original graph.
  const visited = new Uint8Array(nodes.length);
  const finishOrder: number[] = [];
  for (let start = 0; start < nodes.length; start++) {
    if (visited[start]) continue;
    visited[start] = 1;
    const nodeStack = [start];
    const edgeStack = [0];
    while (nodeStack.length) {
      const top = nodeStack.length - 1;
      const node = nodeStack[top];
      const edgeIndex = edgeStack[top];
      if (edgeIndex < adjacency[node].length) {
        const next = adjacency[node][edgeIndex];
        edgeStack[top] = edgeIndex + 1;
        if (!visited[next]) {
          visited[next] = 1;
          nodeStack.push(next);
          edgeStack.push(0);
        }
      } else {
        nodeStack.pop();
        edgeStack.pop();
        finishOrder.push(node);
      }
    }
  }

  // Second pass: components in the reversed graph.
  const componentOf = new Int32Array(nodes.length);
  componentOf.fill(-1);
  const components: number[][] = [];
  for (let i = finishOrder.length - 1; i >= 0; i--) {
    const start = finishOrder[i];
    if (componentOf[start] !== -1) continue;
    const component = components.length;
    const members: number[] = [];
    const stack = [start];
    componentOf[start] = component;
    while (stack.length) {
      const node = stack.pop()!;
      members.push(node);
      for (const next of reverse[node]) {
        if (componentOf[next] !== -1) continue;
        componentOf[next] = component;
        stack.push(next);
      }
    }
    components.push(members);
  }

  const componentEdges = Array.from({ length: components.length }, () => new Set<number>());
  const cyclicComponents = new Uint8Array(components.length);
  for (let component = 0; component < components.length; component++) {
    if (components[component].length > 1) cyclicComponents[component] = 1;
  }
  for (let from = 0; from < adjacency.length; from++) {
    const fromComponent = componentOf[from];
    for (const to of adjacency[from]) {
      const toComponent = componentOf[to];
      if (fromComponent === toComponent) {
        if (from === to) cyclicComponents[fromComponent] = 1;
      } else {
        componentEdges[fromComponent].add(toComponent);
      }
    }
  }
  const componentDag = componentEdges.map((targets) => [...targets]);

  // Kahn order. Processing this in reverse lets each component union already-complete children.
  const indegree = new Int32Array(components.length);
  for (const targets of componentDag) for (const target of targets) indegree[target]++;
  const queue: number[] = [];
  for (let component = 0; component < components.length; component++) {
    if (indegree[component] === 0) queue.push(component);
  }
  const topologicalComponents: number[] = [];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const component = queue[cursor];
    topologicalComponents.push(component);
    for (const target of componentDag[component]) {
      indegree[target]--;
      if (indegree[target] === 0) queue.push(target);
    }
  }

  return {
    nodes, indexOf, adjacency, componentOf, components, componentDag,
    topologicalComponents, cyclicComponents,
  };
}

const REACHABILITY_CHUNK_BITS = 2048;

function popcount32(value: number): number {
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/**
 * Exact reachable-node counts on a component DAG, using chunked bitsets.
 *
 * A Set-valued closure still stores and copies O(V²) JavaScript objects on a chain. Bitsets turn
 * that into word operations, while chunking caps the temporary matrix at 256 bytes per component
 * instead of allocating an unbounded V×V matrix. Shared descendants set one bit and are counted
 * once; SCC members share a closure and subtract only themselves.
 */
function reachableNodeCounts(graph: DependencyGraph, requested: readonly string[]): Map<string, number> {
  const wantedComponents = new Set<number>();
  for (const iri of requested) {
    const node = graph.indexOf.get(iri);
    if (node !== undefined) wantedComponents.add(graph.componentOf[node]);
  }
  const totals = new Int32Array(graph.components.length);

  for (let base = 0; base < graph.nodes.length; base += REACHABILITY_CHUNK_BITS) {
    const chunkSize = Math.min(REACHABILITY_CHUNK_BITS, graph.nodes.length - base);
    const words = Math.ceil(chunkSize / 32);
    const bits = new Uint32Array(graph.components.length * words);

    for (let local = 0; local < chunkSize; local++) {
      const component = graph.componentOf[base + local];
      bits[component * words + (local >>> 5)] |= (1 << (local & 31)) >>> 0;
    }
    for (let i = graph.topologicalComponents.length - 1; i >= 0; i--) {
      const component = graph.topologicalComponents[i];
      const destinationOffset = component * words;
      for (const target of graph.componentDag[component]) {
        const sourceOffset = target * words;
        for (let word = 0; word < words; word++) {
          bits[destinationOffset + word] |= bits[sourceOffset + word];
        }
      }
    }
    for (const component of wantedComponents) {
      const offset = component * words;
      let count = 0;
      for (let word = 0; word < words; word++) count += popcount32(bits[offset + word]);
      totals[component] += count;
    }
  }

  const result = new Map<string, number>();
  for (const iri of requested) {
    const node = graph.indexOf.get(iri);
    if (node !== undefined) result.set(iri, Math.max(0, totals[graph.componentOf[node]] - 1));
  }
  return result;
}

export function unlockCounts(all: Statement[]): Map<string, number> {
  /** Reverse depends-on: prerequisite -> the entity that needs it. */
  const edges: Array<readonly [string, string]> = [];
  const prerequisites = new Set<string>();
  for (const st of all) {
    if (st.p.value !== DEPENDS_ON || !isIRI(st.o)) continue;
    edges.push([st.o.value, st.s.value]);
    prerequisites.add(st.o.value);
  }
  return reachableNodeCounts(buildDependencyGraph(edges), [...prerequisites]);
}

/**
 * Which open decisions must be settled before which others.
 *
 * THE RELATIONS ARE NOT MISSING, THEY ARE SOMEWHERE ELSE. `Statement.blocks` was meant to carry
 * decision ordering and is empty in practice (8 of 529 rows). But the roadmap already states which
 * feature needs which — `kpred:depends-on`, 140 edges — and a decision hangs on a feature. So the
 * order is PROJECTED from the plan rather than invented: if this decision's subject transitively
 * depends on another subject that ALSO has an open decision, that one comes first.
 *
 * Returns, per subject IRI, the open-decision subjects it waits on, plus the subjects that sit in
 * a dependency cycle.
 *
 * HONEST LIMITS, inherited deliberately from queue-tree.ts and unlockCounts:
 *  - This orders what the roadmap DESCRIBES; it does not rank importance. A decision on a feature
 *    absent from the DAG is simply unordered, which is not the same as unimportant.
 *  - A cycle is REPORTED, never silently broken. Every member and every reachable open prerequisite
 *    is returned exactly; the ordering does not paper over a deadlock by cutting a back-edge.
 */
export function decisionDependencies(
  all: Statement[],
  openSubjects: Set<string>,
): { blockedBy: Map<string, string[]>; cycles: Set<string> } {
  /** subject -> the subject it needs. */
  const edges: Array<readonly [string, string]> = [];
  for (const st of all) {
    if (st.p.value !== DEPENDS_ON || !isIRI(st.o)) continue;
    edges.push([st.s.value, st.o.value]);
  }
  const graph = buildDependencyGraph(edges);

  const cycles = new Set<string>();
  for (let component = 0; component < graph.components.length; component++) {
    if (!graph.cyclicComponents[component]) continue;
    for (const node of graph.components[component]) cycles.add(graph.nodes[node]);
  }

  /*
   * Propagate only OPEN subjects through the component DAG. A bit means "this component can reach
   * that open decision". This replaces one whole-graph traversal per subject with one DAG pass per
   * machine-word of open decisions, while preserving exact closures through joins and cycles.
   */
  const open = [...openSubjects];
  const blockedLists = new Map<string, string[]>();
  for (const subject of open) blockedLists.set(subject, []);

  for (let base = 0; base < open.length; base += REACHABILITY_CHUNK_BITS) {
    const chunk = open.slice(base, base + REACHABILITY_CHUNK_BITS);
    const words = Math.ceil(chunk.length / 32);
    const bits = new Uint32Array(graph.components.length * words);
    for (let local = 0; local < chunk.length; local++) {
      const node = graph.indexOf.get(chunk[local]);
      if (node === undefined) continue;
      const component = graph.componentOf[node];
      bits[component * words + (local >>> 5)] |= (1 << (local & 31)) >>> 0;
    }
    for (let i = graph.topologicalComponents.length - 1; i >= 0; i--) {
      const component = graph.topologicalComponents[i];
      const destinationOffset = component * words;
      for (const target of graph.componentDag[component]) {
        const sourceOffset = target * words;
        for (let word = 0; word < words; word++) {
          bits[destinationOffset + word] |= bits[sourceOffset + word];
        }
      }
    }

    for (const subject of open) {
      const node = graph.indexOf.get(subject);
      if (node === undefined) continue;
      const offset = graph.componentOf[node] * words;
      const waiting = blockedLists.get(subject)!;
      for (let word = 0; word < words; word++) {
        let value = bits[offset + word] >>> 0;
        while (value !== 0) {
          const lowBit = (value & -value) >>> 0;
          const bit = 31 - Math.clz32(lowBit);
          const target = chunk[word * 32 + bit];
          if (target !== undefined && target !== subject) waiting.push(target);
          value = (value ^ lowBit) >>> 0;
        }
      }
    }
  }

  const blockedBy = new Map<string, string[]>();
  for (const [subject, waiting] of blockedLists) {
    waiting.sort();
    if (waiting.length) blockedBy.set(subject, waiting);
  }
  return { blockedBy, cycles };
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
  // Rejected and superseded rows remain available to diff/resurrection logic, but they are not
  // live graph context. Letting them price an option, create a conflict, or block a decision makes
  // a fact the user dismissed continue steering the review process.
  const activeAll = all.filter((st) => st.status !== 'rejected' && st.status !== 'superseded');
  const reviewPending = pending.filter(isPendingReview);
  const impacts = blastRadius(reviewPending);
  const unlocks = unlockCounts(activeAll);
  // Built once. See GraphIndex — without this the per-decision work is quadratic in the graph.
  const index = buildGraphIndex(activeAll);
  const statusOf = new Map<string, string>();
  for (const st of activeAll) if (st.p.value === HAS_STATUS && isLit(st.o)) statusOf.set(st.s.value, st.o.value);

  // Conflicts, keyed by subject, so a decision node can say it is contested.
  // findDichotomies reports the entity, the predicate and the divergent VALUES; the STP test
  // needs the STATEMENTS, because it turns on who is competent to settle each side. So resolve
  // them back rather than re-implementing the detection.
  const conflictSides = new Map<string, Statement[]>();
  for (const d of findDichotomies(activeAll)) {
    if (d.kind !== 'conflict') continue;
    const sides = activeAll.filter(
      (st) => st.s.value === d.entityIri && st.p.value === d.predicate && d.values.includes(st.o.value),
    );
    const prev = conflictSides.get(d.entityIri);
    if (prev) prev.push(...sides);
    else conflictSides.set(d.entityIri, sides);
  }

  const bySubject = new Map<string, Statement[]>();
  for (const st of activeAll) {
    const g = bySubject.get(st.s.value);
    if (g) g.push(st);
    else bySubject.set(st.s.value, [st]);
  }

  const openBySubject = new Map<string, Statement[]>();
  for (const st of reviewPending) {
    // A settled fact is never a review item, however open its question reads. The tree filters
    // here rather than trusting the caller: passing a whole confirmed graph in as `pending` is an
    // easy mistake and it silently turns the graph's standing description into a fake backlog.
    if (!isOpenDecision(st)) continue;
    const g = openBySubject.get(st.s.value);
    if (g) g.push(st);
    else openBySubject.set(st.s.value, [st]);
  }

  /** subject IRI -> forcing events (kpred:decides pointing at it). One pass, not one per decision. */
  const forcedByIndex = new Map<string, Statement[]>();
  for (const st of activeAll) {
    if (st.p.value !== DECIDES) continue;
    const list = forcedByIndex.get(st.o.value);
    if (list) list.push(st);
    else forcedByIndex.set(st.o.value, [st]);
  }

  const decisions: DecisionNode[] = [];
  const attached = new Set<string>();

  for (const [subjectIri, questions] of openBySubject) {
    const siblings = bySubject.get(subjectIri) ?? [];
    const options = optionsFor(subjectIri, activeAll, index);
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
        label: labelOf(subjectIri, activeAll, index),
        question: q,
        proseOnly: options.length === 0,
        options,
        standing,
        judgments,
        evidence,
        hidden,
        contested: sides.length > 1,
        conflictSides: sides.length > 1 ? sides : undefined,
        escalate: sides.length > 1 && needsStp(sides, typeOf) ? 'stp' : null,
        forcedBy: forcedByIndex.get(subjectIri) ?? [],
        blockedBy: [],
        inCycle: false,
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
      label: labelOf(subjectIri, activeAll, index),
      question: anchor,
      proseOnly: true,
      options: optionsFor(subjectIri, activeAll, index),
      standing,
      judgments,
      evidence,
      hidden,
      contested: true,
      escalate: 'stp',
      forcedBy: forcedByIndex.get(subjectIri) ?? [],
      blockedBy: [],
      inCycle: false,
      impact: impacts.get(anchor.id) ?? 0,
      unlocks: unlocks.get(subjectIri) ?? 0,
      status: statusOf.get(subjectIri),
      impliedBy: 'conflict',
      conflictValues: [...new Set(sides.map((st) => st.o.value))],
      conflictSides: sides,
    });
  }

  /*
   * DECISION ORDER, projected from the plan's dependency edges (see decisionDependencies).
   * Computed here because it needs the full set of open decisions, which only exists now.
   */
  const openSubjects = new Set(decisions.map((d) => d.subjectIri));
  const deps = decisionDependencies(activeAll, openSubjects);
  for (const d of decisions) {
    d.blockedBy = deps.blockedBy.get(d.subjectIri) ?? [];
    d.inCycle = deps.cycles.has(d.subjectIri);
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
      // PREREQUISITE BEFORE DEPENDANT. Placed under contested/forced (which must never be buried)
      // and ABOVE the weighted signals, because being blocked is not a matter of degree: settling
      // a decision whose foundation is still open is how you end up settling it twice. The blocked
      // one is still shown — lower, and carrying the name of what to settle first.
      Number(a.blockedBy.length > 0) - Number(b.blockedBy.length > 0) ||
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

/* ─────────────────────────────────────────────────────────────────────────────
 * DISTILLATION — turning a prose decision into options a person can weigh.
 *
 * MEASURED 2026-08-21 (npm run offline:decisions): 78 of 78 open decisions in the roadmap are
 * prose-only. Every root renders "no options modelled, so there is nothing to weigh side by side",
 * and the question itself is a truncated paragraph. That is the core premise failing in public:
 * the tree can hide noise and rank by dependency, but the thing it finally shows a human is still
 * a wall of text with no alternatives.
 *
 * `distillationRequest()` above has defined the contract since 2026-08-19 and NOTHING EXECUTES IT
 * — `graph-decisions.ts` calls it only to print the task name. These types and this validator are
 * the missing half: what a model may return, and what makes its answer safe to show.
 *
 * THE LOAD-BEARING RULE IS THAT AN OPTION MUST ALREADY BE ON THE TABLE. Aggregation's rule is
 * traceability of the recorded VALUE (one fact settles fifty, so an invented value launders itself
 * into fifty settled facts). Distillation's risk is different and worse: an invented OPTION is a
 * course of action nobody proposed, presented to the human in the frame of their own material. They
 * would be choosing between alternatives the project never considered, believing the graph offered
 * them. So every option must be grounded in the question's own words or in the facts supplied —
 * the model SPLITS and PHRASES what is already there, and may not add a course of action.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ProposedOptions {
  subjectIri: string;
  options: Array<{
    /** Short label for the alternative — display text, never a new entity. */
    label: string;
    /** One line on what taking it means. Display only; never becomes a fact. */
    consequence?: string;
    /** Ids of supplied facts that would die if this option won. Must be ids from the request. */
    rulesOutIds?: string[];
  }>;
  /** A one-line restatement of the question. Display only, and checked against the original. */
  restated?: string;
}

export interface DistillationOutcome {
  /** Options that survived every check, safe to show beside the question. */
  options: Array<{ label: string; consequence?: string; rulesOutIds: string[] }>;
  /** The restatement, only if it stayed faithful to the original question. */
  restated?: string;
  /**
   * Why each rejected item was rejected, in full — never swallowed.
   *
   * The rejection rate IS the measurement that decides whether this tier earns its place (F74.3:
   * offloading is not free). A harness that quietly dropped bad proposals would make a model that
   * is 80% noise look identical to one that is 5% noise.
   */
  rejected: string[];
}

/** Words too common to prove an option came from the source text. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'for', 'with', 'as', 'by', 'at', 'from', 'that', 'this', 'it', 'its',
  'not', 'no', 'do', 'does', 'can', 'could', 'should', 'would', 'will', 'may', 'might', 'must',
  'one', 'two', 'per', 'each', 'every', 'any', 'all', 'some', 'more', 'most', 'than', 'so',
  'we', 'you', 'they', 'them', 'their', 'our', 'what', 'which', 'who', 'how', 'why', 'when',
]);

const significantTokens = (s: string): string[] =>
  (s.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t));

const normalizeLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.;:,]+$/, '');

/**
 * Validate a model's proposed options against the question and facts it was given.
 *
 * Rejects, loudly and with reasons: fewer than two options (one alternative is not a decision),
 * duplicate labels, labels that restate the question, labels whose content does not appear in the
 * source material, invented fact ids, and a restatement that drops the question's subject matter.
 */
export function validateProposedOptions(
  proposal: ProposedOptions,
  request: DistillationRequest,
  opts: { minGroundedTokens?: number } = {},
): DistillationOutcome {
  const minGrounded = opts.minGroundedTokens ?? 1;
  const rejected: string[] = [];
  const options: DistillationOutcome['options'] = [];

  if (proposal.subjectIri && proposal.subjectIri !== request.subjectIri) {
    rejected.push(`proposal is for ${proposal.subjectIri} but the request was for ${request.subjectIri} — refusing to attach options to a different decision`);
    return { options: [], rejected };
  }

  // The source material. An option must be findable in here.
  const sourceText = [request.question, ...request.facts.map((f) => `${f.predicate} ${f.object}`)].join(' \n ');
  const sourceTokens = new Set(significantTokens(sourceText));
  const validIds = new Set(request.sourceIds);
  const questionNorm = normalizeLabel(request.question);
  const seen = new Set<string>();

  for (const [i, o] of (proposal.options ?? []).entries()) {
    const where = `option ${i}`;
    const label = (o?.label ?? '').trim();

    if (label.length < 2) { rejected.push(`${where}: empty label`); continue; }
    if (label.length > 120) {
      rejected.push(`${where}: ${label.length}-character label is a paragraph, not an alternative — the point is to weigh them side by side`);
      continue;
    }

    const norm = normalizeLabel(label);
    if (seen.has(norm)) { rejected.push(`${where}: "${label.slice(0, 40)}" duplicates an earlier option`); continue; }
    if (norm === questionNorm || questionNorm.includes(norm) && norm.length > 40) {
      rejected.push(`${where}: restates the question instead of offering a way it could go`);
      continue;
    }

    // THE GROUNDING CHECK — an invented option is a course of action nobody proposed.
    const tokens = significantTokens(label);
    const grounded = tokens.filter((t) => sourceTokens.has(t));
    if (tokens.length && grounded.length < Math.min(minGrounded, tokens.length)) {
      rejected.push(
        `${where}: "${label.slice(0, 50)}" shares no significant term with the question or its ${request.facts.length} facts — ` +
        `an option nobody proposed must not be offered as if the graph did`,
      );
      continue;
    }

    const ruleIds = o.rulesOutIds ?? [];
    const unknown = ruleIds.filter((id) => !validIds.has(id));
    if (unknown.length) {
      rejected.push(`${where}: names ${unknown.length} fact id(s) not in the request — ${unknown.slice(0, 3).join(', ')}`);
      continue;
    }

    seen.add(norm);
    options.push({ label, consequence: o.consequence?.trim() || undefined, rulesOutIds: ruleIds });
  }

  // AN OPTION'S PRICE MUST DISCRIMINATE. Observed on the first real run (2026-08-21,
  // qwen3-coder): all three options for one decision claimed to kill the SAME nine facts. A price
  // identical across every option is not a price — it tells the reader nothing about what choosing
  // one costs that the others do not, while looking like hard graph-derived evidence. Better to
  // drop the prices and show the options bare than to show a column that cannot inform the choice.
  if (options.length > 1) {
    const keys = options.map((o) => [...o.rulesOutIds].sort().join(','));
    if (keys[0] !== '' && keys.every((k) => k === keys[0])) {
      rejected.push(
        `every option rules out the same ${options[0].rulesOutIds.length} fact(s), so the cost column cannot ` +
        `distinguish them — prices dropped, options kept`,
      );
      for (const o of options) o.rulesOutIds = [];
    }
  }

  if (options.length === 1) {
    rejected.push(`only one option survived — a decision with a single course of action is not a decision, so none are shown`);
    return { options: [], rejected };
  }

  // A restatement is display-only, but a restatement that drifts is worse than none: the human
  // would answer a question the graph never asked.
  let restated: string | undefined;
  if (proposal.restated?.trim()) {
    const r = proposal.restated.trim();
    const rTokens = significantTokens(r);
    const overlap = rTokens.filter((t) => sourceTokens.has(t)).length;
    if (r.length > 200) rejected.push(`restatement is ${r.length} characters — a restatement that long has not distilled anything`);
    else if (rTokens.length && overlap / rTokens.length < 0.5) {
      rejected.push(`restatement shares only ${overlap}/${rTokens.length} significant terms with the original — it has drifted off the question`);
    } else restated = r;
  }

  return { options, restated, rejected };
}
