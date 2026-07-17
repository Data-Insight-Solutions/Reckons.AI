/**
 * Entity-granularity review (F83 remaining, kb:graph-legibility) — 233 entity cards, not 1888
 * triple rows.
 *
 * "Reviewing 1888 rows one at a time is its own unusability." The same legibility rule F83 applies
 * to the CANVAS (a value earns a node by being shared; the rest are attributes) applies to the
 * REVIEW SURFACE: a person does not decide about triples, they decide about THINGS. Bundle every
 * pending fact about one subject into a single card, so the human works through entities — a
 * bounded, meaningful count — instead of a flat wall of rows.
 *
 * This composes F88 (verifiability): each card carries the STRONGEST gate among its facts (who is
 * competent to clear it), so a card lands in the right lane as a unit. Pure: it groups and counts,
 * it never settles anything.
 */
import type { Statement } from './types';
import { gateFor, type Gate } from './verifiability';
import { labelFromIRI } from './semantic-diff';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';

/** A pending fact is one awaiting a decision. Settled/terminal statuses are not under review. */
export function isPendingReview(st: Statement): boolean {
  return st.status === 'pending' || st.status === 'pending-removal';
}

export interface EntityReviewCard {
  entityIri: string;
  label: string;
  /** Every pending fact about this entity, in the order given. */
  facts: Statement[];
  /** status 'pending' — new facts proposed. */
  additions: number;
  /** status 'pending-removal' — deletions proposed. */
  removals: number;
  /** partial facts (F32) — open questions the human must answer. */
  questions: number;
  /** The strongest gate among the facts: who must clear this card (user > agent > machine). */
  gate: Gate;
  /** Most recent updatedAt among the facts — for recency sorting. */
  updatedAt: number;
}

const GATE_RANK: Record<Gate, number> = { user: 2, agent: 1, machine: 0 };

/** The stronger of two gates — the one that pulls a card toward the human. */
function strongerGate(a: Gate, b: Gate): Gate {
  return GATE_RANK[b] > GATE_RANK[a] ? b : a;
}

/** Best label for an entity: an rdfs:/skos: label among its own facts, else derived from the IRI. */
function labelFor(iri: string, facts: Statement[]): string {
  const labelFact = facts.find((s) => (s.p.value === RDFS_LABEL || s.p.value === SKOS_LABEL) && s.o.kind === 'literal');
  return labelFact ? labelFact.o.value : labelFromIRI(iri);
}

/**
 * Group pending facts into one card per subject entity. `typeOf` resolves a subject to its
 * rdf:type so F88 authority reservations hold (facts about a Tenet/Decision are the user's,
 * however checkable). Non-IRI subjects (blank nodes) are grouped by their own key. Cards are
 * ranked so the human's lane surfaces first: strongest gate, then the fullest card, then recency.
 */
export function groupPendingByEntity(
  statements: Statement[],
  typeOf: (subjectIri: string) => string | undefined = () => undefined,
): EntityReviewCard[] {
  const bySubject = new Map<string, Statement[]>();
  for (const st of statements) {
    if (!isPendingReview(st)) continue;
    const key = st.s.value;
    const g = bySubject.get(key);
    if (g) g.push(st);
    else bySubject.set(key, [st]);
  }

  const cards: EntityReviewCard[] = [];
  for (const [iri, facts] of bySubject) {
    let gate: Gate = 'machine';
    let updatedAt = 0;
    let additions = 0;
    let removals = 0;
    let questions = 0;
    for (const st of facts) {
      gate = strongerGate(gate, gateFor(st, typeOf(st.s.value)));
      if (st.updatedAt > updatedAt) updatedAt = st.updatedAt;
      if (st.status === 'pending-removal') removals++;
      else additions++;
      if (st.needsObject) questions++;
    }
    cards.push({ entityIri: iri, label: labelFor(iri, facts), facts, additions, removals, questions, gate, updatedAt });
  }

  // Human lane first (strongest gate), then the fullest cards, then most recent; id for determinism.
  return cards.sort(
    (a, b) =>
      GATE_RANK[b.gate] - GATE_RANK[a.gate] ||
      b.facts.length - a.facts.length ||
      b.updatedAt - a.updatedAt ||
      a.entityIri.localeCompare(b.entityIri),
  );
}

/** Honest headline: how much the entity view condenses the flat row count. */
export function entityReviewSummary(cards: EntityReviewCard[]): string {
  const rows = cards.reduce((n, c) => n + c.facts.length, 0);
  if (cards.length === 0) return 'Nothing to review.';
  return `${cards.length} entit${cards.length === 1 ? 'y' : 'ies'} to review (${rows} fact${rows === 1 ? '' : 's'}).`;
}
