/**
 * CASCADE AGGREGATION (F139.1) — aggregate the noise, ask ONE question, settle all of it.
 *
 * Matt, 2026-08-19: "The LLM should be processing the bare fact, and not only doing a written
 * summary, the facts should be aggregated and decisions should be asked of the user that cascade
 * down to the facts that are noise. 50 statements of datetime stamps are noise, one question, did
 * this work occur on X date? should be extrapolated and one question asked to the user. The user's
 * fact statement recorded and other facts updated from that one decision point."
 *
 * THIS IS A DIFFERENT MECHANISM FROM SUMMARIZATION, AND THE DIFFERENCE IS THE WHOLE POINT. A
 * summary produces prose a person reads and then still has to settle 50 rows. A cascade produces
 * ONE ANSWERABLE QUESTION whose answer settles 50 rows, records the person's own fact, and leaves
 * a trail from each settled row back to the decision that settled it. Review effort goes from
 * O(facts) to O(decisions), which is the only shape in which review scales at all.
 *
 * THE THREE PARTS:
 *
 *   1. AGGREGATE   Find facts that are facets of ONE underlying claim, so one answer settles all
 *                  of them honestly. A narrow floor of this is computable; the rest is judgment.
 *
 *   2. EXTRAPOLATE Turn the cluster's shared key into the question a person can actually answer:
 *                  "Did this work occur on 2026-08-16?" not "review these 50 facts".
 *
 *   3. CASCADE     Record the answer as the USER'S OWN FACT, then propagate it to every member,
 *                  each one stamped with the decision that settled it (settledByDecision) so the
 *                  whole batch is auditable and reversible from one place.
 *
 * THE DETERMINISTIC BASES ARE A FLOOR, NOT THE MECHANISM — AND CONFLATING THEM WAS A REAL ERROR
 * IN AN EARLIER VERSION OF THIS FILE. Matt, 2026-08-19: "It is not just script tier… the
 * summarization of many detailed facts into accurate decision points is not mechanically viable…
 * aggregation and dependency decisions I'm certain need LLM assistance."
 *
 * He is right, and the distinction is sharp. A `groupBy` over datestamps produces a MECHANICAL
 * BATCH: "these 50 facts mention 2026-08-16." That is a correct grouping and it is not a decision
 * point — nothing in it tells you what question is worth asking about those 50 facts, which of them
 * bear on the same underlying claim, or what settling them would mean. Reaching an ACCURATE
 * DECISION POINT requires reading the facts and judging what they are collectively about, which is
 * judgment over language and therefore the agent tier (F74.3). The same holds for DEPENDENCY: the
 * graph's `depends-on` edges state some prerequisites, but which decision must be settled before
 * another is usually a judgment about consequence that nobody has written down.
 *
 * So the tiers here are:
 *
 *   FLOOR (script)   clusterForCascade() — same-date and same-source ONLY. Free and exact, but
 *                    limited to mechanical batches. Deliberately narrow: see the note in the body
 *                    on why a shared predicate+value is NOT a valid basis.
 *   PRIMARY (agent)  a local model reads the BARE FACTS and proposes the decision points and the
 *                    dependencies between them — validateProposedAggregation() is the harness that
 *                    makes its output trustworthy, by rejecting anything not traceable to the facts.
 *
 * WHAT MAKES THE MODEL'S OUTPUT SAFE IS THE VALIDATOR, NOT THE PROMPT. Every member id must exist
 * in the request; the value the cascade would record must be traceable to the members' own objects;
 * clusters may not overlap; decision-altitude facts may never be batched. A proposal failing any of
 * those is rejected loudly rather than trimmed into acceptability.
 *
 * F52 HOLDS THROUGHOUT: agents propose, humans settle. A cascade is not an exception to that rule,
 * it is the rule made affordable — the human still makes every decision, they just stop making the
 * same decision fifty times.
 */
import type { Statement } from './types';
import { isLit } from './types';
import { altitudeOf, type Altitude } from './fact-altitude';
import { labelFromIRI } from './semantic-diff';

const KPRED = 'urn:kbase:predicate/';

/** What binds a cluster together — and therefore how much a script can vouch for it. */
export type ClusterBasis =
  /** Every member's literal carries the same datestamp. A script computed this; it cannot be wrong. */
  | 'same-date'
  /** Every member arrived from one ingest/extraction run, so one trust decision covers them all. */
  | 'same-source'
  /** A model proposed the grouping because no computable key existed. Weakest; always shown as such. */
  | 'semantic';

export const BASIS_META: Record<ClusterBasis, { label: string; deterministic: boolean }> = {
  'same-date': { label: 'all dated the same day', deterministic: true },
  'same-source': { label: 'all from one source', deterministic: true },
  semantic: { label: 'grouped by a model — check the members', deterministic: false },
};

/** How a single answer propagates to the members. */
export type CascadeAction =
  /** Yes — the shared claim holds. Members become confirmed. */
  | 'confirm'
  /** No — the shared claim does not hold. Members become rejected. */
  | 'reject'
  /** The claim holds but with a corrected value; members are superseded by the recorded fact. */
  | 'correct'
  /**
   * The answer RESTRUCTURES the set: one cluster becomes several, each with its own purpose.
   *
   * Matt, 2026-08-19: "What if the question is, 'what is the main goal of this set of work?' and was
   * asked because the work wasn't related to a product design decision in the roadmap. The user may
   * reply, this work consisted of a package update and debugging. The fact set that was defined
   * before the user response should be adjusted to two sets, and the package upgrade itself labelled
   * appropriately, and the debugging after also labeled appropriately with their purpose. Not a
   * simple application, but the logical semantic one."
   *
   * So a cascade is not only status propagation. A free-text answer can reveal that the cluster was
   * never one thing, and the members must be re-partitioned along the lines the PERSON drew. That
   * needs a second model pass — see validateProposedPartition, and note that its invariants are what
   * make re-partitioning safe rather than lossy.
   */
  | 'partition';

export interface FactCluster {
  /** Stable id derived from the basis and key, so the same cluster keeps its identity across reads. */
  id: string;
  basis: ClusterBasis;
  /** The computed key that bound them: the date, the source id, or the model's stated rationale. */
  key: string;
  /** The ONE question a person answers. */
  question: string;
  /** Every fact this answer would settle. */
  members: Statement[];
  /** The altitude of the members — a cascade over logs is cheap, over decisions it is not allowed. */
  altitude: Altitude;
  /** The fact the user's answer records, as subject/predicate/object. */
  proposes: { subject: string; predicate: string; object: string };
}

/** Facts a cascade may settle. A DECISION is never batch-settled — that is the thing being asked. */
const CASCADABLE: Altitude[] = ['log', 'record', 'evidence'];

const DATE_IN_TEXT = /\b(20\d\d-\d\d-\d\d)\b/;

/**
 * Group facts into cascade clusters, cheapest basis first.
 *
 * A fact joins at most ONE cluster: overlapping clusters would let two answers settle the same
 * fact differently, and the second answer would silently overwrite the first. So the bases are
 * applied in order of how strongly they bind — a shared datestamp is a tighter claim than a shared
 * source — and a fact already claimed is skipped.
 *
 * `minSize` exists because a "cluster" of one is just a fact, and asking a cascade question about a
 * single fact adds a step instead of removing fifty.
 */
export function clusterForCascade(
  statements: Statement[],
  opts: { minSize?: number; subjectLabel?: (iri: string) => string } = {},
): FactCluster[] {
  const minSize = opts.minSize ?? 3;
  const labelOf = opts.subjectLabel ?? labelFromIRI;
  const claimed = new Set<string>();
  const clusters: FactCluster[] = [];

  const eligible = statements.filter((st) => CASCADABLE.includes(altitudeOf(st)));

  // BASIS 1: same datestamp. Matt's example, and the tightest binding available.
  const byDate = new Map<string, Statement[]>();
  for (const st of eligible) {
    if (!isLit(st.o)) continue;
    const m = DATE_IN_TEXT.exec(st.o.value);
    if (!m) continue;
    // PUSH, DO NOT SPREAD. Rebuilding the array on every insert is O(n^2): measured 2026-08-19 on a
    // 40,433-fact synced graph, the spread version of this loop and the source loop below took
    // clusterForCascade to 749ms of main-thread work, and it is $derived — so it re-ran on every
    // change and made the review page feel unresponsive.
    const dateList = byDate.get(m[1]);
    if (dateList) dateList.push(st);
    else byDate.set(m[1], [st]);
  }
  for (const [date, members] of [...byDate].sort((a, b) => b[1].length - a[1].length)) {
    const fresh = members.filter((st) => !claimed.has(st.id));
    if (fresh.length < minSize) continue;
    for (const st of fresh) claimed.add(st.id);
    // One subject if they share one, otherwise the cluster is about the work, not the entity.
    const subjects = new Set(fresh.map((st) => st.s.value));
    const subject = subjects.size === 1 ? [...subjects][0] : `urn:kbase:concept/work-${date}`;
    clusters.push({
      id: `cascade:date:${date}`,
      basis: 'same-date',
      key: date,
      question:
        subjects.size === 1
          ? `Did this work on ${labelOf([...subjects][0])} occur on ${date}?`
          : `Did this work occur on ${date}? (${fresh.length} facts across ${subjects.size} entities)`,
      members: fresh,
      altitude: highestAltitude(fresh),
      proposes: { subject, predicate: `${KPRED}work-occurred-on`, object: date },
    });
  }

  /*
   * THERE IS NO same-predicate-value BASIS, AND REMOVING IT WAS A CORRECTION WORTH KEEPING.
   *
   * It was implemented and then deleted on 2026-08-19 after it batched 2,348 facts of the roadmap
   * into 141 "questions" and starved the agent tier of everything real. The bug was not the size,
   * it was the SEMANTICS: `kb:a relates-to kb:x` and `kb:b relates-to kb:x` are INDEPENDENT claims
   * that merely agree. A shared datestamp means the members describe ONE event; a shared source
   * means they came from ONE act of trust. Those are single claims, and one answer legitimately
   * settles them. A shared object value is not a single claim, so batching it would let one answer
   * settle two unrelated assertions — precisely the laundering this file exists to prevent.
   *
   * THE RULE FOR ADDING A BASIS: a cascade is valid only when the members are facets of ONE
   * underlying claim. If one member could be true while another is false, it does not belong.
   */

  /*
   * BASIS 2: same source. One trust decision covers everything it produced — this is the existing
   * source-trust workflow ("trusted/review", auto-confirm for trusted sources) reached from review
   * rather than from ingest.
   *
   * RECORD AND LOG ONLY, NOT EVIDENCE. Measured on the demo graph 2026-08-19: allowing evidence in
   * put 61 facts into one "do you trust this source?" question, including every kpred:measured
   * reading. That contradicts the altitude ordering this whole feature rests on — evidence sits
   * ABOVE record and log precisely because a measurement can pull a judgment out from under itself,
   * so it earns more attention than a link does. Trusting a source is a weaker claim than confirming
   * a measurement, and the weaker claim must not settle the stronger fact.
   */
  const bySource = new Map<string, Statement[]>();
  for (const st of eligible) {
    if (claimed.has(st.id) || !st.sourceId) continue;
    const alt = altitudeOf(st);
    if (alt !== 'record' && alt !== 'log') continue;
    const srcList = bySource.get(st.sourceId);
    if (srcList) srcList.push(st);
    else bySource.set(st.sourceId, [st]);
  }
  for (const [sourceId, members] of [...bySource].sort((a, b) => b[1].length - a[1].length)) {
    const fresh = members.filter((st) => !claimed.has(st.id));
    if (fresh.length < minSize) continue;
    for (const st of fresh) claimed.add(st.id);
    clusters.push({
      id: `cascade:src:${sourceId}`,
      basis: 'same-source',
      key: sourceId,
      question: `Accept all ${fresh.length} bookkeeping facts from this source? (links and work notes only — no measurements)`,
      members: fresh,
      altitude: highestAltitude(fresh),
      proposes: { subject: `urn:kbase:source/${sourceId}`, predicate: `${KPRED}source-trusted`, object: 'true' },
    });
  }

  // Biggest saving first: a cluster that removes 50 rows outranks one that removes 3.
  return clusters.sort((a, b) => b.members.length - a.members.length || a.id.localeCompare(b.id));
}

function highestAltitude(members: Statement[]): Altitude {
  const order: Altitude[] = ['decision', 'judgment', 'evidence', 'record', 'log'];
  for (const a of order) if (members.some((st) => altitudeOf(st) === a)) return a;
  return 'log';
}

/**
 * Should this cluster be asked for its PURPOSE rather than its truth?
 *
 * Matt's trigger, and it is a real detectable condition: the question "what is the main goal of this
 * set of work?" is worth asking precisely when the work is not tied to any product design decision.
 * A batch of completion notes hanging off a Feature already has its purpose — the Feature. A batch
 * hanging off nothing is unexplained work, and no yes/no question can fix that, because the missing
 * information is not a truth value. It is a reason.
 *
 * `isPlanned` resolves whether a subject is anchored in the plan (typed as a Feature/Phase, or
 * linked into one). Passing nothing conservatively treats everything as unanchored, which asks more
 * questions rather than silently assuming purpose.
 */
export function needsPurposeQuestion(
  cluster: FactCluster,
  isPlanned: (subjectIri: string) => boolean = () => false,
): boolean {
  return !cluster.members.some((st) => isPlanned(st.s.value));
}

/** The purpose question itself — open, because its answer is prose, not yes/no. */
export function purposeQuestion(cluster: FactCluster): string {
  const n = cluster.members.length;
  return `What was the main goal of this set of work? (${n} fact${n === 1 ? '' : 's'}, ${BASIS_META[cluster.basis].label}, not tied to any planned feature)`;
}

/** What the second model pass is given: the cluster's facts and the person's own words. */
export interface PartitionRequest {
  clusterId: string;
  /** The user's answer, verbatim. The ONLY source of purposes. */
  answer: string;
  facts: Array<{ id: string; subject: string; predicate: string; object: string }>;
}

/** Raw second-pass output. UNTRUSTED until validateProposedPartition. */
export interface ProposedPartition {
  parts: Array<{
    /** The purpose, in the USER'S terms — taken from their answer, never invented. */
    purpose: string;
    memberIds: string[];
  }>;
}

export interface PartitionPart {
  purpose: string;
  /** Slug for the work-unit entity this part becomes. */
  slug: string;
  members: Statement[];
}

export interface PartitionOutcome {
  parts: PartitionPart[];
  rejected: string[];
}

const STOPWORDS = new Set([
  'this','that','work','consisted','and','the','of','a','an','was','were','with','for','some','then','after','before','plus','also','it','its','into','from','only','just','mostly','both',
]);

/** Content words of a phrase — what must be traceable to the user's answer. */
function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

export function slugifyPurpose(purpose: string): string {
  return purpose.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unlabelled';
}

/**
 * Validate a proposed re-partition of a cluster.
 *
 * THREE INVARIANTS, AND ALL THREE ARE ABOUT NOT LOSING THE USER'S MEANING:
 *
 *   EXHAUSTIVE   Every member lands in exactly one part. A fact silently dropped by a re-partition
 *                is a fact that was under review and now is not — the worst possible outcome, since
 *                nobody would notice it went missing.
 *   DISJOINT     No member appears twice. Two purposes on one fact is not a partition, it is a
 *                contradiction the graph would carry forever.
 *   TRACEABLE    Every purpose's content words must appear in the USER'S ANSWER. The model draws the
 *                lines between the facts — that is the judgment it is here for — but the LABELS are
 *                the person's. A model free to invent purposes could relabel a package bump as a
 *                security fix and the graph would record it as the user's own statement.
 *
 * A single part is rejected too: if the answer described one thing, the cluster did not need
 * partitioning and a `confirm` with a purpose is the honest action.
 */
export function validateProposedPartition(
  proposal: ProposedPartition,
  cluster: FactCluster,
  answer: string,
): PartitionOutcome {
  const rejected: string[] = [];
  const byId = new Map(cluster.members.map((st) => [st.id, st]));
  const answerWords = new Set(contentWords(answer));
  const seen = new Set<string>();
  const parts: PartitionPart[] = [];

  for (const [i, part] of (proposal.parts ?? []).entries()) {
    const where = `part ${i}`;
    const purpose = (part.purpose ?? '').trim();
    if (!purpose) {
      rejected.push(`${where}: no purpose given`);
      continue;
    }

    const words = contentWords(purpose);
    const untraceable = words.filter((w) => !answerWords.has(w));
    if (words.length === 0 || untraceable.length) {
      rejected.push(
        `${where}: purpose "${purpose}" is not in the answer — ` +
          `${untraceable.length ? `invented word(s): ${untraceable.join(', ')}` : 'no content words'}`,
      );
      continue;
    }

    const unknown = (part.memberIds ?? []).filter((id) => !byId.has(id));
    if (unknown.length) {
      rejected.push(`${where}: names ${unknown.length} fact(s) not in this cluster`);
      continue;
    }
    const dupes = (part.memberIds ?? []).filter((id) => seen.has(id));
    if (dupes.length) {
      rejected.push(`${where}: ${dupes.length} fact(s) already in another part — a partition must be disjoint`);
      continue;
    }
    if ((part.memberIds ?? []).length === 0) {
      rejected.push(`${where}: empty`);
      continue;
    }

    for (const id of part.memberIds) seen.add(id);
    parts.push({ purpose, slug: slugifyPurpose(purpose), members: part.memberIds.map((id) => byId.get(id)!) });
  }

  // EXHAUSTIVE: nothing may be left behind.
  const missing = cluster.members.filter((st) => !seen.has(st.id));
  if (missing.length) {
    rejected.push(
      `partition is not exhaustive: ${missing.length} of ${cluster.members.length} fact(s) assigned to no part — ` +
        `rejecting the whole partition rather than silently dropping them`,
    );
    return { parts: [], rejected };
  }

  if (parts.length < 2) {
    rejected.push(`only ${parts.length} valid part — the answer did not describe more than one kind of work, so this is a confirm, not a partition`);
    return { parts: [], rejected };
  }

  return { parts, rejected };
}

export interface PartitionResult {
  /** One work-unit entity per part, carrying the purpose in the user's own words. */
  recorded: Statement[];
  /** Every member, linked to the work unit its purpose puts it under. */
  updated: Statement[];
  effect: string;
}

/**
 * Apply a validated partition: mint a work unit per purpose, and file every fact under one.
 *
 * The purposes are recorded as the USER'S attestation (`verifiableBy: 'user'`, sourceId 'manual'),
 * because that is exactly what they are — their account of what the work was for. The member facts
 * become confirmed and carry `part-of` the work unit plus the decision that settled them, so the
 * re-partition is as reversible as any other cascade.
 */
export function applyPartition(
  outcome: PartitionOutcome,
  cluster: FactCluster,
  answer: string,
  settler: { actor: string; channel: string; at?: number; graph?: string },
): PartitionResult {
  if (outcome.parts.length < 2) throw new Error('applyPartition: nothing validated to partition');
  const at = settler.at ?? Date.now();
  const graph = { kind: 'iri', value: settler.graph ?? 'urn:kbase:graph/manual' };
  const decisionId = `${cluster.id}#partition@${at}`;

  const recorded: Statement[] = [];
  const updated: Statement[] = [];

  for (const part of outcome.parts) {
    const unit = `urn:kbase:concept/work-${part.slug}`;
    recorded.push({
      id: `${decisionId}:${part.slug}`,
      s: { kind: 'iri', value: unit },
      p: { kind: 'iri', value: `${KPRED}purpose` },
      o: { kind: 'literal', value: part.purpose },
      g: graph,
      sourceId: 'manual',
      confidence: 1,
      status: 'confirmed',
      verifiableBy: 'user',
      settledBy: { actor: settler.actor, channel: settler.channel, at },
      settledByDecision: decisionId,
      createdAt: at,
      updatedAt: at,
    } as unknown as Statement);

    for (const st of part.members) {
      updated.push({
        ...st,
        status: 'confirmed',
        settledByDecision: decisionId,
        updatedAt: at,
      } as Statement);
      // The link that gives the fact its purpose.
      recorded.push({
        id: `${decisionId}:${part.slug}:${st.id}`,
        s: st.s,
        p: { kind: 'iri', value: `${KPRED}part-of` },
        o: { kind: 'iri', value: unit },
        g: graph,
        sourceId: 'manual',
        confidence: 1,
        status: 'confirmed',
        verifiableBy: 'user',
        settledByDecision: decisionId,
        createdAt: at,
        updatedAt: at,
      } as unknown as Statement);
    }
  }

  const names = outcome.parts.map((p) => `"${p.purpose}"`).join(' and ');
  return {
    recorded,
    updated,
    effect: `Your answer split ${cluster.members.length} facts into ${outcome.parts.length} sets — ${names} — each labelled with its purpose.`,
  };
}

export interface CascadeResult {
  /**
   * The USER'S OWN FACT — what they actually decided, recorded once as a real statement.
   *
   * This is the fact that survives. It is attested by the person (verifiableBy 'user', sourceId
   * 'manual'), which is honest: nothing but their word backs it, and labelling it as such is what
   * keeps it from being laundered into looking measured.
   */
  recorded: Statement;
  /** Every member, updated by the one answer, each stamped with the decision that settled it. */
  updated: Statement[];
  /** Plain sentence for the log/notification: what one answer just did. */
  effect: string;
}

/**
 * Apply one answer to a whole cluster.
 *
 * PURE — it returns what to write and writes nothing, so the caller (the store) stays the only
 * thing that mutates state and the whole cascade is unit-testable.
 *
 * PROVENANCE IS NOT OPTIONAL. Every member carries settledByDecision pointing at the recorded
 * fact, and the recorded fact carries the settler and the time. The handoff's rule is exact: "A
 * settled fact whose settler is unknown is worse than an unsettled one, because it looks
 * reviewed." Fifty facts settled at once by an unattributed answer would be fifty times worse.
 */
export function applyCascade(
  cluster: FactCluster,
  answer: CascadeAction,
  settler: { actor: string; channel: string; at?: number; correctedObject?: string; graph?: string },
): CascadeResult {
  const at = settler.at ?? Date.now();

  // Refuse to batch-settle a decision. The cluster bases cannot produce one today, but a future
  // basis could, and a cascade that could settle decisions would be a way to bulk-approve the
  // only facts that were ever supposed to be considered one at a time.
  if (cluster.altitude === 'decision') {
    throw new Error('applyCascade: refusing to batch-settle decision-altitude facts');
  }

  const object = answer === 'correct' && settler.correctedObject ? settler.correctedObject : cluster.proposes.object;
  const decisionId = `${cluster.id}@${at}`;

  const recorded = {
    id: decisionId,
    s: { kind: 'iri', value: cluster.proposes.subject },
    p: { kind: 'iri', value: cluster.proposes.predicate },
    o: { kind: 'literal', value: object },
    g: { kind: 'iri', value: settler.graph ?? 'urn:kbase:graph/manual' },
    sourceId: 'manual',
    confidence: 1,
    status: 'confirmed',
    // Their word, and nothing else. Said plainly rather than blended in with measured facts.
    verifiableBy: 'user',
    settledBy: { actor: settler.actor, channel: settler.channel, at },
    createdAt: at,
    updatedAt: at,
  } as unknown as Statement;

  const nextStatus = answer === 'reject' ? 'rejected' : answer === 'correct' ? 'superseded' : 'confirmed';
  const updated = cluster.members.map(
    (st) =>
      ({
        ...st,
        status: nextStatus,
        settledByDecision: decisionId,
        updatedAt: at,
      }) as Statement,
  );

  const verb = answer === 'reject' ? 'rejected' : answer === 'correct' ? 'superseded' : 'confirmed';
  return {
    recorded,
    updated,
    effect: `One answer ${verb} ${updated.length} fact${updated.length === 1 ? '' : 's'} (${BASIS_META[cluster.basis].label}), recorded as your own statement.`,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE AGENT TIER — a model proposes the decision points; a validator makes it safe.
 * ──────────────────────────────────────────────────────────────────────────── */

/** What the model is given: the BARE FACTS, and the decisions already open. Nothing else. */
export interface AggregationRequest {
  facts: Array<{ id: string; subject: string; predicate: string; object: string }>;
  /**
   * Decisions already open, so the model can ATTACH a cluster to an existing question instead of
   * minting a near-duplicate of it. Without this the same decision gets asked twice in slightly
   * different words, which is the duplicate-proposal problem F80.1 exists to clean up.
   */
  openDecisions: Array<{ id: string; subject: string; question: string }>;
}

/** Raw model output. UNTRUSTED — nothing here is used before validateProposedAggregation. */
export interface ProposedAggregation {
  clusters: Array<{
    memberIds: string[];
    /** The decision point these facts imply. */
    question: string;
    /** The fact the user's answer would record. */
    proposes: { subject: string; predicate: string; object: string };
    /** Why they belong together, in the model's words. DISPLAY ONLY — never becomes a fact. */
    rationale?: string;
    /** An existing open decision this cluster belongs under, if the model found one. */
    attachTo?: string;
  }>;
  /** Dependencies between decisions the model believes exist. */
  dependencies: Array<{ blocker: string; blocked: string; because?: string }>;
}

export interface ProposedDependency {
  blocker: string;
  blocked: string;
  because?: string;
}

export interface ValidationOutcome {
  /** Clusters that survived every check, ready to be shown to a person. */
  clusters: FactCluster[];
  /** Dependencies whose endpoints are both real open decisions. */
  dependencies: ProposedDependency[];
  /**
   * Why each rejected item was rejected, in full.
   *
   * Reported rather than swallowed, because rejection rate IS the measurement that decides whether
   * this tier is worth running. A harness that quietly dropped bad proposals would make a model
   * that is 80% noise look identical to one that is 5% noise (F74.3: offloading is not free).
   */
  rejected: string[];
}

/** Predicate namespaces a proposal may write into. Anything else is an invented vocabulary. */
const ALLOWED_PREDICATE_PREFIXES = [KPRED, 'urn:kbase:', 'http://www.w3.org/2000/01/rdf-schema#'];

/**
 * Validate a model's aggregation proposal against the facts it was given.
 *
 * THE LOAD-BEARING RULE IS TRACEABILITY OF THE RECORDED VALUE. A cascade writes one fact and then
 * settles fifty on the strength of it, so if the model may invent that value, one hallucination
 * launders itself into fifty settled facts. So `proposes.object` must appear in a member's own
 * object text (or be a date drawn from it). The model may choose WHICH value and how to PHRASE the
 * question; it may not introduce a value the facts do not contain.
 */
export function validateProposedAggregation(
  proposal: ProposedAggregation,
  request: AggregationRequest,
  statements: Statement[],
  opts: { minSize?: number } = {},
): ValidationOutcome {
  const minSize = opts.minSize ?? 3;
  const byId = new Map(statements.map((st) => [st.id, st]));
  const inRequest = new Set(request.facts.map((f) => f.id));
  const openIds = new Set(request.openDecisions.map((d) => d.id));
  const claimed = new Set<string>();

  const clusters: FactCluster[] = [];
  const rejected: string[] = [];

  for (const [i, c] of (proposal.clusters ?? []).entries()) {
    const where = `cluster ${i}`;

    const unknown = (c.memberIds ?? []).filter((id) => !inRequest.has(id) || !byId.has(id));
    if (unknown.length) {
      rejected.push(`${where}: names ${unknown.length} fact id(s) that were not in the request — ${unknown.slice(0, 3).join(', ')}`);
      continue;
    }

    const members = (c.memberIds ?? []).map((id) => byId.get(id)!);
    if (members.length < minSize) {
      rejected.push(`${where}: only ${members.length} members, below the minimum of ${minSize} — one question per fact is not aggregation`);
      continue;
    }

    const overlap = members.filter((st) => claimed.has(st.id));
    if (overlap.length) {
      rejected.push(`${where}: ${overlap.length} member(s) already claimed by an earlier cluster — two answers must never settle one fact`);
      continue;
    }

    const alt = highestAltitude(members);
    if (alt === 'decision') {
      rejected.push(`${where}: contains decision-altitude facts — decisions are never batch-settled`);
      continue;
    }
    if (alt === 'judgment') {
      rejected.push(`${where}: contains judgment-altitude facts — a qualitative verdict is not noise to be cleared in bulk`);
      continue;
    }

    const question = (c.question ?? '').trim();
    if (question.length < 8 || !question.endsWith('?')) {
      rejected.push(`${where}: "${question.slice(0, 60)}" is not a question a person can answer`);
      continue;
    }

    const p = c.proposes;
    if (!p?.subject || !p?.predicate || p.object === undefined || p.object === null) {
      rejected.push(`${where}: incomplete proposed fact`);
      continue;
    }
    if (!ALLOWED_PREDICATE_PREFIXES.some((prefix) => p.predicate.startsWith(prefix))) {
      rejected.push(`${where}: predicate ${p.predicate} is outside the graph's vocabulary`);
      continue;
    }

    // THE TRACEABILITY CHECK.
    const object = String(p.object).trim();
    const traceable = members.some((st) => {
      const v = isLit(st.o) ? st.o.value : st.o.value;
      return v.includes(object) || object.includes(v) || (DATE_IN_TEXT.exec(v)?.[1] === object);
    });
    if (!traceable) {
      rejected.push(`${where}: would record "${object.slice(0, 40)}", which appears in none of its ${members.length} members — invented values cannot settle facts`);
      continue;
    }

    if (c.attachTo && !openIds.has(c.attachTo)) {
      rejected.push(`${where}: attaches to unknown decision ${c.attachTo}`);
      continue;
    }

    for (const st of members) claimed.add(st.id);
    clusters.push({
      id: `cascade:semantic:${i}:${object.slice(0, 40)}`,
      basis: 'semantic',
      key: c.rationale?.slice(0, 80) ?? object,
      question,
      members,
      altitude: alt,
      proposes: { subject: p.subject, predicate: p.predicate, object },
    });
  }

  const dependencies: ProposedDependency[] = [];
  for (const [i, d] of (proposal.dependencies ?? []).entries()) {
    if (!openIds.has(d.blocker) || !openIds.has(d.blocked)) {
      rejected.push(`dependency ${i}: names a decision that is not open — ${d.blocker} → ${d.blocked}`);
      continue;
    }
    if (d.blocker === d.blocked) {
      rejected.push(`dependency ${i}: a decision cannot block itself`);
      continue;
    }
    dependencies.push({ blocker: d.blocker, blocked: d.blocked, because: d.because });
  }

  return { clusters: clusters.sort((a, b) => b.members.length - a.members.length), dependencies, rejected };
}

/** Build the request. Bare facts only — no gloss, no prose, nothing for a model to parrot back. */
export function aggregationRequest(
  statements: Statement[],
  openDecisions: Array<{ id: string; subject: string; question: string }>,
): AggregationRequest {
  return {
    facts: statements
      .filter((st) => CASCADABLE.includes(altitudeOf(st)))
      .map((st) => ({
        id: st.id,
        subject: st.s.value.replace('urn:kbase:concept/', 'kb:'),
        predicate: st.p.value.replace(KPRED, 'kpred:'),
        object: isLit(st.o) ? st.o.value : st.o.value,
      })),
    openDecisions,
  };
}

/** What the cascade lane saves, honestly: rows removed per question asked. */
export function cascadeSummary(clusters: FactCluster[]): string {
  if (clusters.length === 0) return 'Nothing to batch — no cluster of noise big enough to be worth one question.';
  const rows = clusters.reduce((n, c) => n + c.members.length, 0);
  const det = clusters.filter((c) => BASIS_META[c.basis].deterministic).length;
  return (
    `${clusters.length} question${clusters.length === 1 ? '' : 's'} settles ${rows} fact${rows === 1 ? '' : 's'}` +
    ` — ${(rows / clusters.length).toFixed(1)} per question` +
    (det === clusters.length
      ? ', every grouping computed rather than guessed.'
      : `, ${clusters.length - det} grouped by a model.`)
  );
}
