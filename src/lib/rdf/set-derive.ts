/**
 * SET DERIVATION (F187.3, arm c) — finding groupings that are ALREADY THERE, with no model.
 *
 * The roadmap names four process arms for getting sets out of extraction and says which to try
 * first (kb:staged-extraction, .constraint): "(c) DERIVE DETERMINISTICALLY, group by a shared
 * predicate with no model at all, which kb:entity-sets already shows works and which the
 * work-tiering ladder says to try BEFORE prompting". This is that arm.
 *
 * WHY IT COMES FIRST, and the evidence is not abstract. The set bench (2026-09-09, four models ×
 * five runs) measured what asking a model to group actually gets you:
 *
 *   - the best model found 10 of 15 sets, at 0.50 member recall and 0.44 precision;
 *   - OVERLAP — one entity in two sets, the capability skos:Collection was chosen FOR — scored
 *     0 of 5 across every model and every run;
 *   - the two models that scored 5/5 on the trap did so by grouping NOTHING at all.
 *
 * Against that, a rule that finds a grouping which is already stated is right by construction.
 * It cannot hallucinate a member, because it never proposes a member that is not already an object
 * in the graph, and it costs nothing to run.
 *
 * WHAT IT DOES NOT DO, deliberately. It cannot notice a grouping the source states in prose and
 * extraction flattened ("Aprimo, OpenText and Bynder went on the shortlist" → three unrelated
 * facts). That is genuinely a judgment task and belongs to arm (b) or (d). This arm is the floor,
 * not the ceiling, and the baseline any model arm must beat.
 *
 * AND IT PROPOSES, IT NEVER WRITES. Every candidate is a pending statement a human rules on. The
 * queue is already long (548 rows, 2026-09-08) and the documented failure of offloading is a job
 * that emits noise and moves cost from generation to triage — so the thresholds here are set to
 * refuse rather than to find, and `whyNot` records every near miss so the refusals are auditable
 * instead of silent.
 */
import { v4 as uuid } from 'uuid';
import type { Statement } from './types';
import { COLLECTION, MEMBER_PREDICATE, PREF_LABEL } from './sets';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

/**
 * How many objects one (subject, predicate) needs before it looks like a grouping.
 *
 * THREE, NOT TWO. At two, every ordinary pair of facts about a subject becomes a candidate set and
 * the queue fills with noise — the exact failure mode the bench caught in the one model that did
 * form sets (mistral-small3.2, which fell into the "this is not a group" trap 5 times out of 5).
 * Two things sharing a predicate is how predicates normally work; three is when it starts to look
 * like a list.
 */
export const MIN_MEMBERS = 3;

/**
 * Predicates that are plural by nature and are NOT groupings.
 *
 * This list is the honest weak point of the whole module and is written down rather than hidden:
 * it is a judgment encoded as a rule, and it will be wrong at the edges. It exists because the
 * review procedure already learned this lesson expensively — `kpred:unexplained-term` had 94
 * "competing" claims that did not compete, and `kpred:principle` is plural on 101 of 191 subjects.
 * An accumulating predicate is not a grouping: a feature with many files is not a set of files.
 *
 * Matched by LOCAL NAME so it holds across namespaces.
 */
export const ACCUMULATING_PREDICATES = new Set([
  'has-file', 'tested-by', 'principle', 'measured', 'decided', 'evidence', 'constraint',
  'known-issue', 'remaining', 'open-question', 'description', 'note', 'comment', 'label',
  'unexplained-term', 'depends-on', 'relates-to', 'see-also', 'broader', 'narrower', 'type',
  // Added 2026-09-11 after the first real-graph run: a note with six `has-property` edges is a
  // thing with six attributes, not a set of six members.
  'has-property', 'has-attribute', 'property', 'attribute', 'mentions', 'references',
]);

/** Structural predicates that describe the graph rather than the world. */
const META_PREFIXES = [
  'urn:reckons:nav/',
  // Story authoring — which nodes a walkthrough step highlights. Presentational, like nav, and
  // excluded for the same reason: it describes how the graph is SHOWN, not what is in the world.
  'urn:reckons:story/',
  'urn:reckons:meta/',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  'http://www.w3.org/2000/01/rdf-schema#',
];

/**
 * MEMBERSHIP IS A CLAIM ABOUT THE WORLD — provenance and questions cannot carry it (F194).
 *
 * FOUND BY RUNNING IT, not by reasoning about it. The first run of this rule over a real graph
 * (reckons-workspace/kbs/personal-notes) proposed four sets and every one was wrong; three grouped
 * by `kpred:extracted-from`. "This note was extracted from those four notes" is a record of where
 * text came from, and reading it as membership would propose a set for every note in every graph.
 * 0% precision — reported rather than quietly tuned away, because the failure is the useful part:
 * an exclusion LIST would have needed a new entry, where a layer needed one declaration.
 *
 * So the classification is read from the GRAPH (kpred:layer, F194's vocabulary) rather than kept
 * as a list here. A predicate classified once is then right for the MCP layer split, the review
 * disposition and this rule together.
 *
 * The structural fallback below mirrors mcp-server/src/layers.ts and must stay in step with it.
 * Deliberately duplicated rather than imported: tests/bench importing across the package boundary
 * is what put mcp-server into the SvelteKit type program and broke CI on 2026-09-10.
 */
const LAYER_PREDICATE = 'urn:kbase:predicate/layer';
const LAYER_SCHEME_PREFIX = 'urn:kbase:type/layer/';
const STRUCTURAL_PROVENANCE = ['urn:kbase:meta/', 'http://www.w3.org/ns/prov#', 'urn:reckons:meta/'];
/*
 * Provenance by CONSTRUCTION rather than by namespace — this app writes them as records of how a
 * statement came to be, so they are provenance in any graph, whether or not that graph carries the
 * vocabulary that declares them. Without this floor, a caller who forgets to pass the vocabulary's
 * declarations gets junk sets rather than none — and the caller who forgot was me.
 */
const STRUCTURAL_PROVENANCE_PREDICATES = [
  'urn:kbase:predicate/extracted-from',
  'urn:kbase:predicate/assumption',
  'urn:kbase:predicate/derived-from',
  'urn:kbase:predicate/source',
];
const STRUCTURAL_QUESTION = ['urn:kbase:predicate/open-question'];

/**
 * Predicates the graph itself says are NOT claims.
 *
 * Read from the statements passed in, so a graph that classifies its own vocabulary is believed
 * over any assumption made here. An unclassified predicate stays a claim — F194's fail-safe, and
 * the right one: it means a new predicate is eligible for grouping rather than silently excluded.
 */
function nonClaimPredicates(statements: Statement[]): Set<string> {
  const out = new Set<string>();
  for (const st of statements) {
    if (st.p.value !== LAYER_PREDICATE || st.s.kind !== 'iri') continue;
    const raw = st.o.value.startsWith(LAYER_SCHEME_PREFIX) ? st.o.value.slice(LAYER_SCHEME_PREFIX.length) : st.o.value;
    if (raw === 'provenance' || raw === 'question') out.add(st.s.value);
  }
  return out;
}

function isStructuralNonClaim(predicate: string): boolean {
  return STRUCTURAL_PROVENANCE.some((ns) => predicate.startsWith(ns))
    || STRUCTURAL_PROVENANCE_PREDICATES.includes(predicate)
    || STRUCTURAL_QUESTION.includes(predicate);
}

export interface DerivedSet {
  /** The subject that already groups these — a set is not minted, an existing node is recognized. */
  iri: string;
  /** The predicate the membership is already carried by. */
  via: string;
  members: string[];
}

export interface DerivationReport {
  derived: DerivedSet[];
  /** Every (subject, predicate) that had enough members but was refused, and why. */
  whyNot: Array<{ iri: string; via: string; members: number; reason: string }>;
}

const localName = (iri: string): string => iri.split(/[/#]/).filter(Boolean).pop() ?? iri;

function isMeta(predicate: string): boolean {
  return META_PREFIXES.some((p) => predicate.startsWith(p));
}

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/**
 * Groupings already present in `statements`, as candidates.
 *
 * `alreadySets` names subjects that are known sets already, so a second run does not re-propose
 * what a reviewer has accepted. Re-proposing an accepted fact is how a queue becomes unreadable.
 */
export function deriveSets(
  statements: Statement[],
  alreadySets: Set<string> = new Set(),
  /** Extra layer classifications from graphs not in `statements` — e.g. the shipped vocabulary. */
  declaredNonClaim: Set<string> = new Set(),
): DerivationReport {
  const nonClaim = new Set([...nonClaimPredicates(statements), ...declaredNonClaim]);
  /* (subject, predicate) -> distinct IRI objects, in the order the graph stated them. */
  const groups = new Map<string, { iri: string; via: string; members: string[] }>();

  for (const st of statements) {
    if (!isActive(st)) continue;
    if (st.s.kind !== 'iri' || st.o.kind !== 'iri') continue;   // a literal is a value, not a member
    if (st.needsObject) continue;                                // an open question has no object yet
    const key = `${st.s.value}${st.p.value}`;
    const g = groups.get(key) ?? { iri: st.s.value, via: st.p.value, members: [] };
    if (!g.members.includes(st.o.value)) g.members.push(st.o.value);
    groups.set(key, g);
  }

  const derived: DerivedSet[] = [];
  const whyNot: DerivationReport['whyNot'] = [];

  for (const g of groups.values()) {
    if (g.members.length < MIN_MEMBERS) continue;   // not a near miss; just ordinary facts
    const reason =
      alreadySets.has(g.iri) ? 'already a set'
      : isMeta(g.via) ? 'structural predicate — describes the graph, not the world'
      : nonClaim.has(g.via) || isStructuralNonClaim(g.via) ? 'provenance or question — membership is a claim about the world'
      : ACCUMULATING_PREDICATES.has(localName(g.via)) ? 'accumulating predicate — plural by nature, not a grouping'
      : g.members.includes(g.iri) ? 'subject is its own member'
      : null;
    if (reason) { whyNot.push({ iri: g.iri, via: g.via, members: g.members.length, reason }); continue; }
    derived.push(g);
  }

  // Biggest groupings first — the ones most worth a reviewer's attention.
  derived.sort((a, b) => b.members.length - a.members.length || a.iri.localeCompare(b.iri));
  whyNot.sort((a, b) => b.members - a.members);
  return { derived, whyNot };
}

/**
 * The pending statements that would make a derived grouping readable as a set.
 *
 * TWO STATEMENTS PER SET, NOT N. The membership edges already exist; restating them as skos:member
 * would duplicate N facts to add nothing and would put N more rows into the search index (see the
 * measurement in scripts/offline/set-complexity.ts). So the proposal is only the type declaration
 * and the predicate the membership already travels under.
 *
 * They arrive as `pending` like any other proposal. Nothing here writes to a graph.
 */
export function derivedSetStatements(
  derived: DerivedSet,
  source: { id: string; graph: string },
  now = Date.now(),
): Statement[] {
  const common = {
    g: { kind: 'iri' as const, value: source.graph },
    sourceId: source.id,
    /*
     * 0.5, and it is a real number rather than a polite one. The rule is certain about what it
     * SAW — three edges sharing a predicate, which is not in doubt — and says nothing about
     * whether the author meant a grouping. That is exactly the judgment the reviewer supplies,
     * so the confidence reports the rule's actual epistemic position rather than its precision.
     */
    confidence: 0.5,
    status: 'pending' as const,
    createdAt: now,
    updatedAt: now,
  };
  const s = { kind: 'iri' as const, value: derived.iri };
  const memberNames = derived.members.slice(0, 3).map(localName).join(', ');
  const more = derived.members.length > 3 ? ` +${derived.members.length - 3} more` : '';

  return [
    {
      id: uuid(), s,
      p: { kind: 'iri', value: RDF_TYPE },
      o: { kind: 'iri', value: COLLECTION },
      gloss: `${localName(derived.iri)} groups ${derived.members.length} entities (${memberNames}${more}) — is it a set?`,
      ...common,
    },
    {
      id: uuid(), s,
      p: { kind: 'iri', value: MEMBER_PREDICATE },
      o: { kind: 'iri', value: derived.via },
      gloss: `Membership of ${localName(derived.iri)} is carried by "${localName(derived.via)}".`,
      ...common,
    },
  ];
}

/**
 * A label proposal for a derived set, when the subject has none.
 *
 * Separate from `derivedSetStatements` because it is a different KIND of claim: the two above
 * state structure that is already in the graph, this one invents a string. Kept optional so a
 * caller can take the structure without the naming.
 */
export function derivedSetLabel(derived: DerivedSet, source: { id: string; graph: string }, now = Date.now()): Statement {
  const name = localName(derived.iri).replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
  return {
    id: uuid(),
    s: { kind: 'iri', value: derived.iri },
    p: { kind: 'iri', value: PREF_LABEL },
    o: { kind: 'literal', value: name },
    g: { kind: 'iri', value: source.graph },
    sourceId: source.id,
    confidence: 0.4,
    status: 'pending',
    gloss: `Name this set "${name}"?`,
    createdAt: now,
    updatedAt: now,
  };
}
