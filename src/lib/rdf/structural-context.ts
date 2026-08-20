/**
 * STRUCTURAL GROUNDING (F136.3) — let a new fact know what the graph already depends on, at the
 * moment it is defined.
 *
 * Matt, 2026-08-19: "I think we need more intensive review and inclusion of current graph when
 * defining new facts. The dependency for tree could be better determined with the context of the
 * current graph more available during the definition of the new fact?"
 *
 * THIS IS THE ROOT CAUSE OF A DEFECT MEASURED ELSEWHERE IN THIS REPO, NOT A SPECULATIVE IMPROVEMENT.
 * The F139 review tree ranks open decisions by how much is stalled behind them, and that ranking was
 * INERT on the real graph: `Statement.blocks` is populated on 8 of 529 queue rows, so blastRadius()
 * had nothing to walk and the tree fell back to creation order — surfacing speculative notes about
 * NVIDIA models above live architectural decisions. The workaround was to project ranking from the
 * roadmap's 140 `kpred:depends-on` edges after the fact. But the reason those edges are sparse in the
 * first place is that NOTHING KNOWS THE GRAPH WHEN A FACT IS BORN: extraction sees the source text
 * and a title, emits isolated triples, and every structural relation has to be inferred later by
 * something with less information than the extractor had.
 *
 * F136 (vocabulary-context.ts) already established the pattern for WORDS — offer the predicates the
 * graph uses so a model stops minting synonyms. This is the same move for STRUCTURE:
 *
 *   vocabulary grounding   "we call it is-found-in, not has-habitat"
 *   structural grounding   "kb:entity-sets already exists, it depends on kb:graph-legibility, and it
 *                           has an OPEN QUESTION about storage — if this text bears on that, say so"
 *
 * WHAT IT CHANGES DOWNSTREAM. A fact that arrives already attached lands UNDER the decision it bears
 * on in the tree, instead of in the orphan tail. A `depends-on` stated at definition time gives
 * unlockCounts() real signal instead of a 140-edge approximation of a much larger truth.
 *
 * GROUNDING MUST NOT BECOME A CAGE — F136's constraint, and it binds here harder. A prompt that
 * enumerated existing entities and demanded the model pick one would suppress genuinely new things,
 * and a well-formed absence is the most valuable node in the graph. So: anchors are offered as
 * PREFERENCE, minting a new entity stays available, and validateStructuralClaims() distinguishes an
 * invented reference from a new one — a dependency on something the same batch introduced is
 * legitimate, a dependency on something that exists nowhere is not.
 *
 * SCRIPT TIER (F74.3). Selection is deterministic — lexical overlap with the source text plus degree
 * in the graph. No embedding call, no model, no tokens, so it works on the offline WASM path and in
 * tests without a network. The predicate-threshold benchmark (kb:predicate-threshold-limit) is a
 * standing reminder that cosine over short labels is weaker than it looks, so an embedding-ranked
 * variant is deliberately not taken first.
 */
import type { Statement } from './types';
import { isLit, isIRI } from './types';
import { altitudeOf, isOpenDecision } from './fact-altitude';
import { slugFromIRI } from './vocabulary-context';

const KPRED = 'urn:kbase:predicate/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/**
 * Predicates that carry STRUCTURE rather than description — the ones worth teaching a model to use,
 * because they are what the review tree and the dependency ranking actually read.
 */
export const STRUCTURAL_PREDICATES = ['depends-on', 'part-of', 'blocks', 'gated-by', 'has-phase'] as const;

/** How many existing entities to offer as attachment anchors. Small models follow a short list. */
const DEFAULT_ANCHOR_BUDGET = 12;
/** How many open decisions to offer. More than a handful and the model stops reading them. */
const DEFAULT_DECISION_BUDGET = 6;

export interface StructuralAnchor {
  /** Kebab slug, exactly as the extractor is asked to emit a subject. */
  slug: string;
  label: string;
  /** What this entity already depends on, as slugs — real edges, so a model can extend the chain. */
  dependsOn: string[];
  /** Lifecycle status when it has one, so a model can tell live work from a parked idea. */
  status?: string;
  /** Degree in the graph — used for ranking, not shown to the model. */
  degree: number;
}

export interface OpenDecisionAnchor {
  slug: string;
  /** The question itself, trimmed. A model attaches to a question it can read. */
  question: string;
}

export interface StructuralContext {
  anchors: StructuralAnchor[];
  openDecisions: OpenDecisionAnchor[];
  /** Every entity slug known to the graph — the validator's allow-list. */
  knownSlugs: Set<string>;
}

export interface SelectStructuralOptions {
  anchorBudget?: number;
  decisionBudget?: number;
  /** Source text, so anchors overlapping what is being ingested rank first. */
  sourceText?: string;
}

/** Words from the source text worth matching an anchor label against. */
function textTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Select the structural context for an ingest.
 *
 * Anchors are ranked by LEXICAL OVERLAP with the source text first and degree second. Overlap
 * before degree is deliberate: the most connected entity in the graph is rarely the one this
 * particular document is about, and offering it would invite the model to attach a fact to whatever
 * happens to be the biggest hub — which is how a graph acquires edges that mean nothing.
 */
export function selectStructuralContext(
  statements: Statement[],
  opts: SelectStructuralOptions = {},
): StructuralContext {
  const anchorBudget = opts.anchorBudget ?? DEFAULT_ANCHOR_BUDGET;
  const decisionBudget = opts.decisionBudget ?? DEFAULT_DECISION_BUDGET;
  const tokens = textTokens(opts.sourceText ?? '');

  const labels = new Map<string, string>();
  const degree = new Map<string, number>();
  const dependsOn = new Map<string, string[]>();
  const status = new Map<string, string>();
  const knownSlugs = new Set<string>();

  for (const st of statements) {
    if (st.status === 'rejected' || st.status === 'superseded') continue;

    if (isIRI(st.s)) {
      knownSlugs.add(slugFromIRI(st.s.value));
      degree.set(st.s.value, (degree.get(st.s.value) ?? 0) + 1);
    }
    if (isIRI(st.o)) {
      knownSlugs.add(slugFromIRI(st.o.value));
      degree.set(st.o.value, (degree.get(st.o.value) ?? 0) + 1);
    }

    if (st.p.value === RDFS_LABEL && isLit(st.o)) labels.set(st.s.value, st.o.value);
    if (st.p.value === `${KPRED}has-status` && isLit(st.o)) status.set(st.s.value, st.o.value);
    if (st.p.value === `${KPRED}depends-on` && isIRI(st.o)) {
      const list = dependsOn.get(st.s.value);
      if (list) list.push(slugFromIRI(st.o.value));
      else dependsOn.set(st.s.value, [slugFromIRI(st.o.value)]);
    }
  }

  const scored: Array<{ anchor: StructuralAnchor; overlap: number }> = [];
  for (const [iri, deg] of degree) {
    const label = labels.get(iri);
    // An entity with no label is a stub. Offering it teaches nothing and invites attachment to noise.
    if (!label) continue;
    const labelTokens = textTokens(label);
    let overlap = 0;
    for (const t of labelTokens) if (tokens.has(t)) overlap++;
    scored.push({
      anchor: {
        slug: slugFromIRI(iri),
        label,
        dependsOn: dependsOn.get(iri) ?? [],
        status: status.get(iri),
        degree: deg,
      },
      overlap,
    });
  }

  scored.sort(
    (a, b) => b.overlap - a.overlap || b.anchor.degree - a.anchor.degree || a.anchor.slug.localeCompare(b.anchor.slug),
  );

  /*
   * OPEN DECISIONS ARE RANKED, NOT TAKEN IN GRAPH ORDER — and the first version of this function got
   * that wrong in a way worth recording. Taking the first N by document order offered a text about
   * Set View the roadmap's open questions about NVIDIA NeMo sidecars, Cosmos GPU requirements and
   * Facebook's deprecated API. That is exactly the failure F136's own open-question predicts:
   * "picking the wrong subset grounds the model in the wrong vocabulary, which is worse than no
   * grounding." An irrelevant question is not merely wasted prompt — it invites the model to attach
   * a fact to whichever question it was shown.
   *
   * A question with NO overlap with the source text is dropped entirely rather than used as filler:
   * an empty list is honest, and padding it teaches the model that any attachment will do.
   */
  const scoredDecisions: Array<{ anchor: OpenDecisionAnchor; overlap: number }> = [];
  for (const st of statements) {
    if (!isOpenDecision(st)) continue;
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    const q = (isLit(st.o) ? st.o.value : (st.question ?? '')).replace(/\s+/g, ' ').trim();
    if (!q) continue;
    const slug = slugFromIRI(st.s.value);
    // Overlap counts against the question text AND the subject's label: a question phrased in
    // different words than the feature it hangs off is still about that feature.
    const haystack = textTokens(`${q} ${labels.get(st.s.value) ?? ''} ${slug.replace(/-/g, ' ')}`);
    let overlap = 0;
    for (const t of haystack) if (tokens.has(t)) overlap++;
    if (overlap === 0 && tokens.size > 0) continue;
    scoredDecisions.push({ anchor: { slug, question: q.slice(0, 180) }, overlap });
  }
  scoredDecisions.sort((a, b) => b.overlap - a.overlap || a.anchor.slug.localeCompare(b.anchor.slug));

  return {
    anchors: scored.slice(0, anchorBudget).map((s) => s.anchor),
    openDecisions: scoredDecisions.slice(0, decisionBudget).map((d) => d.anchor),
    knownSlugs,
  };
}

/**
 * The prompt block. Appended after the vocabulary section, and empty when the graph has nothing to
 * say — so a first ingest into an empty graph pays nothing for this feature.
 *
 * The wording is PERMISSIVE by design ("if", "when the text says so"). An imperative version was
 * considered and rejected: told to attach every fact, a model attaches every fact, and the graph
 * fills with confident dependencies the source never mentioned. A missing edge is recoverable; a
 * fabricated one is believed.
 */
export function buildStructuralSection(ctx: StructuralContext): string {
  if (ctx.anchors.length === 0 && ctx.openDecisions.length === 0) return '';

  const lines: string[] = ['', 'This graph already contains:'];

  if (ctx.anchors.length > 0) {
    for (const a of ctx.anchors) {
      const bits = [`- ${a.slug} ("${a.label}")`];
      if (a.status) bits.push(`status ${a.status}`);
      if (a.dependsOn.length) bits.push(`depends-on ${a.dependsOn.slice(0, 3).join(', ')}`);
      lines.push(bits.join(' — '));
    }
    lines.push('Reuse one of these subjects when the text is about the same thing. Minting a new');
    lines.push('subject is fine and expected when it genuinely is something new.');
  }

  if (ctx.openDecisions.length > 0) {
    lines.push('', 'Questions this graph has left open:');
    for (const d of ctx.openDecisions) lines.push(`- ${d.slug}: ${d.question}`);
    lines.push('If the text bears on one of these, say so with: part-of <that subject>.');
  }

  lines.push('');
  lines.push('If the text states that one thing REQUIRES or WAITS ON another, emit that as a triple');
  lines.push(`using one of: ${STRUCTURAL_PREDICATES.join(', ')}. Only when the text says so.`);

  return lines.join('\n');
}

export interface StructuralClaim {
  subject: string;
  predicate: string;
  object: string;
}

export interface StructuralValidation<T> {
  kept: T[];
  /** Dropped claims with the reason, reported rather than swallowed. */
  dropped: Array<{ claim: StructuralClaim; reason: string }>;
}

/**
 * Drop structural claims that point nowhere.
 *
 * THE DISTINCTION THAT MATTERS, and it is what keeps grounding from becoming a cage: a dependency on
 * something THIS BATCH introduced is legitimate — a document may well describe two new things and
 * the relation between them, and refusing that would make the extractor unable to express new
 * structure at all. A dependency on something that exists neither in the graph nor in the batch is
 * INVENTED, and a fabricated dependency is worse than a missing one because the ranking will believe
 * it and promote the wrong decision to the top of the tree.
 *
 * Only STRUCTURAL predicates are checked. A descriptive triple with an odd object is a content
 * question for review; a structural one with a dangling object is a defect in the graph's shape.
 */
export function validateStructuralClaims<
  T extends { subject: string; predicate: string; object: string; objectIsLiteral?: boolean },
>(triples: T[], ctx: StructuralContext): StructuralValidation<T> {
  const structural = new Set<string>(STRUCTURAL_PREDICATES);
  // Everything this batch introduces is a legitimate target, whether or not the graph knows it yet.
  const batchSubjects = new Set(triples.map((t) => t.subject));

  const kept: T[] = [];
  const dropped: Array<{ claim: StructuralClaim; reason: string }> = [];

  for (const t of triples) {
    const pred = t.predicate.replace(KPRED, '').replace(/^kpred:/, '');
    if (!structural.has(pred)) {
      kept.push(t);
      continue;
    }
    // A structural relation to a literal is a category error: structure links things, not strings.
    if (t.objectIsLiteral) {
      dropped.push({
        claim: { subject: t.subject, predicate: pred, object: t.object },
        reason: `${pred} points at a literal — structure links entities, not strings`,
      });
      continue;
    }
    if (ctx.knownSlugs.has(t.object) || batchSubjects.has(t.object)) {
      kept.push(t);
      continue;
    }
    dropped.push({
      claim: { subject: t.subject, predicate: pred, object: t.object },
      reason: `${pred} points at "${t.object}", which exists neither in the graph nor in this batch — an invented dependency would mis-rank the review tree`,
    });
  }

  return { kept, dropped };
}

/** Honest one-liner for the ingest report: what grounding was offered, and what it caught. */
export function structuralSummary(ctx: StructuralContext, v?: StructuralValidation<unknown>): string {
  if (ctx.anchors.length === 0 && ctx.openDecisions.length === 0) {
    return 'No graph context to offer — this is a first ingest, or nothing in the graph is labelled.';
  }
  const parts = [`grounded in ${ctx.anchors.length} existing entit${ctx.anchors.length === 1 ? 'y' : 'ies'}`];
  if (ctx.openDecisions.length) parts.push(`${ctx.openDecisions.length} open question${ctx.openDecisions.length === 1 ? '' : 's'}`);
  if (v && v.dropped.length) parts.push(`${v.dropped.length} invented dependenc${v.dropped.length === 1 ? 'y' : 'ies'} dropped`);
  return parts.join('; ') + '.';
}
