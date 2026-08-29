/**
 * Giving an entity a type BEFORE a human is asked to review it.
 *
 * Matt, 2026-08-28: "We need more pre-work before we just add pending undefined garbage. We need
 * types set, before a user reviews."
 *
 * WHAT ARRIVES TODAY. The extractor emits subject/predicate/object and nothing else. Every entity
 * it mints is untyped, so a review card says "orange-logic" with no answer to the first question a
 * person actually asks — WHAT IS THIS? Untyped entities also break things downstream that had no
 * business depending on the extractor's silence: the hub type gate cannot see them, entity shapes
 * cannot check them, and the graph renders them all as the same grey default.
 *
 * THE PRECEDENT IS ALREADY IN THE PIPELINE. `normalizeEntities` does exactly this shape of work —
 * post-extraction, PRE-REVIEW, rewriting IRIs so duplicates never reach the queue as separate
 * entities. Typing is its missing sibling: the same slot, the same purpose, the same rule that
 * fixing it early is cheaper than asking a human about it later.
 *
 * A PROPOSED TYPE DOES NOT ADD A ROW TO THE QUEUE, IT FILLS ONE IN. The type lands as a pending
 * `rdf:type` fact on an entity that already has pending facts, so `groupPendingByEntity` folds it
 * into that entity's existing card. It makes a card more answerable rather than making another
 * card. That distinction is the whole reason this is worth doing: a type as a separate review row
 * would be more queue, which is what Matt is complaining about.
 *
 * AND IT STILL DECLINES. Same doctrine as `altitude-proposals.ts`: propose where the evidence is
 * decisive, report the gap otherwise, never guess. Guessing a type is worse than leaving one
 * blank — a wrong type is inherited by shapes, colours, hub eligibility and review routing, and
 * unlike a blank it looks settled.
 */

import type { Statement } from './types';
import { isIRI, isLit } from './types';
import { RDF_TYPE, type EntityTypeDef } from './entity-types';

/** Predicates whose object NAMES the subject's type. "orange-logic is-a company". */
const TYPING_PREDICATES = new Set(
  ['is-a', 'isa', 'instance-of', 'type', 'kind-of', 'a'].map((p) => `urn:kbase:predicate/${p}`),
);

export type TypeProposal = {
  entityIri: string;
  typeIri: string;
  typeLabel: string;
  /** Why, in words a review card can show. */
  reason: string;
  /** The predicates or values that produced it. */
  evidence: string[];
  /** `stated` — the text said so. `predicates` — inferred from what is known about it. */
  basis: 'stated' | 'predicates';
};

export type UntypedEntity = {
  entityIri: string;
  /** What is known about it, so a person or a model has something to go on. */
  predicates: string[];
};

export type TypingSurvey = {
  proposals: TypeProposal[];
  undecided: UntypedEntity[];
  /** Entities that already carry a type — nothing to do, and not counted as a win. */
  alreadyTyped: number;
};

const shortName = (iri: string) => iri.split(/[/#]/).pop() ?? iri;

/** Normalise a name for comparison: "Web Page", "web-page" and "webpage" are the same word. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Predicates that belong to exactly ONE type, and are therefore evidence.
 *
 * `location` appears on both Place and Event; `description` on four types; `url` on three. Those
 * say nothing about which type an entity is, and counting them would let the type with the longest
 * schema list win every argument. Only a predicate unique to one type is admitted.
 */
export function distinctivePredicates(types: EntityTypeDef[]): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const type of types) {
    for (const predicate of type.schemaPredicates) {
      const set = owners.get(predicate) ?? new Set<string>();
      set.add(type.iri);
      owners.set(predicate, set);
    }
  }
  const distinctive = new Map<string, string>();
  for (const [predicate, ownerSet] of owners) {
    if (ownerSet.size === 1) distinctive.set(predicate, [...ownerSet][0]);
  }
  return distinctive;
}

/**
 * Propose a type for every untyped entity in a batch.
 *
 * `existing` is the graph as it stands: an entity already typed there is left alone, because the
 * pipeline has no business re-deciding what a settled entity is.
 */
export function surveyTypes(
  batch: Statement[],
  types: EntityTypeDef[],
  existing: Statement[] = [],
): TypingSurvey {
  const typedAlready = new Set<string>();
  for (const st of [...existing, ...batch]) {
    if (st.p.value === RDF_TYPE && isIRI(st.s)) typedAlready.add(st.s.value);
  }

  const byType = new Map<string, EntityTypeDef>(types.map((t) => [t.iri, t]));
  const byName = new Map<string, EntityTypeDef>();
  for (const type of types) {
    byName.set(fold(type.label), type);
    byName.set(fold(shortName(type.iri)), type);
  }
  const distinctive = distinctivePredicates(types);

  // Everything each untyped subject says about itself.
  const facts = new Map<string, Statement[]>();
  for (const st of batch) {
    if (!isIRI(st.s) || typedAlready.has(st.s.value)) continue;
    const list = facts.get(st.s.value) ?? [];
    list.push(st);
    facts.set(st.s.value, list);
  }

  const proposals: TypeProposal[] = [];
  const undecided: UntypedEntity[] = [];

  for (const [entityIri, own] of facts) {
    // 1. THE TEXT SAID SO. "Orange Logic is a company" is the strongest evidence there is, and it
    //    came from the source rather than from an inference over conventions.
    const stated = own.find((st) => {
      if (!TYPING_PREDICATES.has(st.p.value)) return false;
      return byName.has(fold(isLit(st.o) ? st.o.value : shortName(st.o.value)));
    });
    if (stated) {
      const value = isLit(stated.o) ? stated.o.value : shortName(stated.o.value);
      const type = byName.get(fold(value))!;
      proposals.push({
        entityIri,
        typeIri: type.iri,
        typeLabel: type.label,
        reason: `the source says it is a ${type.label.toLowerCase()}`,
        evidence: [`${shortName(stated.p.value)} → ${value}`],
        basis: 'stated',
      });
      continue;
    }

    // 2. WHAT IT HAS SAYS WHAT IT IS — but only where a predicate belongs to ONE type, and only
    //    where exactly one type is in the running. A tie is not weak evidence, it is no evidence.
    const hits = new Map<string, string[]>();
    for (const st of own) {
      const owner = distinctive.get(st.p.value);
      if (!owner) continue;
      hits.set(owner, [...(hits.get(owner) ?? []), shortName(st.p.value)]);
    }
    if (hits.size === 1) {
      const [typeIri, evidence] = [...hits][0];
      const type = byType.get(typeIri)!;
      proposals.push({
        entityIri,
        typeIri,
        typeLabel: type.label,
        reason: `only a ${type.label.toLowerCase()} has ${evidence.join(', ')}`,
        evidence,
        basis: 'predicates',
      });
      continue;
    }

    undecided.push({
      entityIri,
      predicates: [...new Set(own.map((st) => shortName(st.p.value)))],
    });
  }

  return { proposals, undecided, alreadyTyped: typedAlready.size };
}

/**
 * Turn proposals into pending `rdf:type` facts.
 *
 * PENDING, NOT CONFIRMED. A type is a claim about what a thing IS, and it is inherited by shapes,
 * colours, hub eligibility and review routing — exactly the kind of claim review exists for. What
 * makes this cheap rather than noisy is that it groups onto an entity's EXISTING card instead of
 * opening a new one.
 */
export function buildTypeStatements(
  proposals: TypeProposal[],
  template: Pick<Statement, 'g' | 'sourceId'>,
  makeId: () => string,
  now = Date.now(),
): Statement[] {
  return proposals.map((p) => ({
    id: makeId(),
    s: { kind: 'iri' as const, value: p.entityIri },
    p: { kind: 'iri' as const, value: RDF_TYPE },
    o: { kind: 'iri' as const, value: p.typeIri },
    g: template.g,
    sourceId: template.sourceId,
    // `stated` came from the source text; `predicates` is this module's own inference, and saying
    // so in the number keeps a guess from wearing the same clothes as a quotation.
    confidence: p.basis === 'stated' ? 0.9 : 0.6,
    status: 'pending' as const,
    gloss: `${p.typeLabel} — ${p.reason}`,
    // Only the person knows what their entity is meant to be. Routing it to `user` keeps it out
    // of any machine lane that might settle it without being asked.
    verifiableBy: 'user' as const,
    createdAt: now,
    updatedAt: now,
  }));
}
