/**
 * Dichotomy detection (kb:dichotomy) — one entity, two truths.
 *
 * Relatedness asks "do these graphs share concepts?" This asks the harder question INSIDE a
 * graph: where does a single, confidently-identified entity say DRASTICALLY DIFFERENT things
 * about itself? "This person was on the sales team; this person is a technical resource." Those
 * two facts might CONFLICT (one is stale/wrong) or they might be a NATURAL DICHOTOMY that
 * cannot and should not be resolved — a person who was in sales and is now technical is both.
 *
 * The distinction matters because it drives review. A conflict is something to fix before a
 * merge; a natural dichotomy is something to PRESERVE through one. Surfacing them — filterable,
 * like hubs and islands — makes the graph's genuine tensions the focus of review, which is
 * exactly where a human's attention buys the most.
 *
 * TWO GATES, both necessary (the second is Matt's key insight):
 *   1. The entity must be WELL-IDENTIFIED — a real thing, not a loose concept. Divergent values
 *      on a stub tell you nothing; divergent values on a fully-formed entity are a signal.
 *   2. The divergence must be on a DESCRIBING attribute, not a structural link. A feature with
 *      many kpred:has-file links is not in dichotomy — that is just how files work. Two
 *      different `role`s or `status`es or `description`s is the thing.
 *
 * DETERMINISTIC TIER. This finds divergence STRUCTURALLY (same subject, same predicate,
 * distinct objects) and classifies by the predicate's cardinality convention. It does NOT yet
 * judge how semantically "drastic" the difference is — that needs embeddings (the app's
 * embed.ts) and is the next tier. Here, distinct values on a describing predicate of a
 * well-identified entity IS the signal; the embedding tier will rank them by how far apart.
 */
import type { Statement } from './types';
import { termKey, isLit } from './types';

const KPRED = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/**
 * Predicates whose object DESCRIBES the entity — where two different values is a dichotomy.
 * Structural predicates (has-file, part-of, depends-on, relates-to…) are deliberately excluded:
 * having many of those is normal, not a divergence.
 */
const DESCRIBING = new Set([
  `${KPRED}description`,
  `${KPRED}role`,
  `${KPRED}status`,
  `${KPRED}has-status`,
  `${KPRED}definition`,
  `${KPRED}summary`,
  `${KPRED}note`,
  `${KPRED}title`,
  `${KPRED}category`,
  `${KPRED}kind`,
  'http://www.w3.org/2004/02/skos/core#definition',
]);

/**
 * Predicates where exactly ONE value is expected. Divergent values here are a CONFLICT — one is
 * likely wrong. Elsewhere among describing predicates, divergent values are a NATURAL dichotomy
 * that may coexist (two roles, two facets) and should be representable rather than resolved.
 */
const SINGLE_VALUED = new Set([`${KPRED}has-status`, `${KPRED}status`, `${KPRED}category`, `${KPRED}kind`]);

export type DichotomyKind = 'conflict' | 'dichotomy';

export interface Dichotomy {
  /** Node key of the entity in tension. */
  key: string;
  entityIri: string;
  /** The predicate on which it diverges. */
  predicate: string;
  /** The two-or-more distinct values. */
  values: string[];
  kind: DichotomyKind;
  /** How strongly identified the entity is (0..1) — higher means "we are sure this is one thing". */
  identity: number;
}

/**
 * Identity strength: are we confident this subject is a single, real entity? A thing with a
 * type and a label and several facts is one; a bare IRI mentioned once is not. Divergence only
 * means something once identity is high — that is the whole point of the second gate.
 */
function identityStrength(iri: string, bySubject: Map<string, Statement[]>): number {
  const own = bySubject.get(iri) ?? [];
  if (own.length === 0) return 0;
  const hasType = own.some((s) => s.p.value === RDF_TYPE);
  const hasLabel = own.some((s) => s.p.value === RDFS_LABEL);
  // type + label + volume. Capped at 1. A stub (1-2 triples, no type) scores low and is skipped.
  return Math.min(1, (hasType ? 0.4 : 0) + (hasLabel ? 0.3 : 0) + Math.min(0.3, own.length / 20));
}

/**
 * Find the entities that say drastically different things about themselves.
 *
 * `minIdentity` is the second gate: only entities we are confident are ONE thing qualify, so a
 * loose concept with two stray values is not flagged as being in tension with itself.
 */
export function findDichotomies(statements: Statement[], minIdentity = 0.6): Dichotomy[] {
  const bySubject = new Map<string, Statement[]>();
  for (const s of statements) {
    if (s.status === 'rejected' || s.status === 'superseded') continue;
    if (s.s.kind !== 'iri') continue;
    bySubject.set(s.s.value, [...(bySubject.get(s.s.value) ?? []), s]);
  }

  const out: Dichotomy[] = [];
  for (const [iri, own] of bySubject) {
    const identity = identityStrength(iri, bySubject);
    if (identity < minIdentity) continue; // gate 1: must be a well-identified entity

    // Group this entity's DESCRIBING values by predicate.
    const byPred = new Map<string, Set<string>>();
    for (const s of own) {
      if (!DESCRIBING.has(s.p.value)) continue; // gate 2: describing attributes only
      if (!isLit(s.o)) continue; // a described value is a literal, not a link
      const set = byPred.get(s.p.value) ?? new Set<string>();
      set.add(s.o.value.trim());
      byPred.set(s.p.value, set);
    }

    for (const [pred, values] of byPred) {
      if (values.size < 2) continue; // no divergence
      out.push({
        key: termKey(own[0].s),
        entityIri: iri,
        predicate: pred,
        values: [...values],
        kind: SINGLE_VALUED.has(pred) ? 'conflict' : 'dichotomy',
        identity,
      });
    }
  }

  // Conflicts first (they block a clean merge), then by identity — the surer we are it is one
  // thing, the more a divergence matters.
  return out.sort((a, b) => (a.kind === b.kind ? b.identity - a.identity : a.kind === 'conflict' ? -1 : 1));
}

/** Node keys of entities in dichotomy — for the graph filter, exactly like hubs/islands. */
export function dichotomyNodeKeys(statements: Statement[], minIdentity = 0.6): string[] {
  return [...new Set(findDichotomies(statements, minIdentity).map((d) => d.key))];
}
