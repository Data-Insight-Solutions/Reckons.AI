/**
 * SYNONYMS SURVIVE AN INGEST — the same fix as merge-aliases.ts, one path earlier.
 *
 * THE PROBLEM THIS FIXES. `normalizeEntities` folds an incoming entity onto an existing one
 * when their labels embed closely enough (kb:entity-normalization). It rewrites the subject
 * IRI and nothing else — so the incoming `rdfs:label` survives the rewrite and lands on the
 * canonical entity as a SECOND rdfs:label with a different value. computeDiff sees one
 * subject, one predicate, two objects and classifies that as a `conflicts` entry; the review
 * UI asks a human to pick a winner and sets the loser to `rejected`.
 *
 * That is exactly the bug F126 fixed for merges (kb:merge-synonyms), sitting unnoticed on the
 * ingest path: the name a source actually used — the name the next import will arrive as —
 * gets thrown away as the loser of a conflict nobody should have been asked to resolve. Two
 * names for one thing is not a contradiction. It is a synonym, and it is the single most
 * valuable piece of vocabulary an ingest produces, because the graph just proved the two names
 * denote one entity.
 *
 * WHY THIS IS THE CHEAP PLACE TO LEARN VOCABULARY. `kb:node-synonyms` plans a UI where a user
 * types aliases onto a node by hand. That will always be the smaller source: normalization
 * already computes a name pair and a similarity score on every single ingest, and the previous
 * code kept them only to `console.info` a line and drop them (the `remaps` field is documented
 * "for logging"). The thesaurus F104 wants is being derived and discarded several times a day.
 *
 * PENDING, NOT CONFIRMED — and this is the one place it differs from merge-aliases.ts. There,
 * a human had just settled a merge, so asking them to review the alias it implies would be
 * asking the same question twice. Here nobody has agreed to anything: an embedding decided two
 * labels were close, and `kb:node-synonyms` is explicit that "an embedding-PROPOSED alias
 * lands as PENDING for review and is never auto-applied. A vocabulary the user did not agree
 * to is not user-managed." So these arrive in the review queue like any other proposed fact,
 * carrying the cosine that proposed them as their confidence.
 */

import type { Statement } from './types';
import { SKOS_ALT_LABEL } from './merge-aliases';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

/** One subject remap reported by `normalizeEntities`. */
export type SubjectRemap = { from: string; to: string; kind: 'subject' | 'predicate'; similarity: number };

/** A name preserved rather than lost, with the evidence that justified preserving it. */
export type AliasConversion = {
  /** The entity that kept its identity and now carries the alias. */
  iri: string;
  /** The name the source used. */
  value: string;
  /** The IRI the source minted, before normalization folded it away. */
  fromIri: string;
  /** Cosine similarity that justified the fold (1 for an exact label match). */
  similarity: number;
};

/** Labels differing only by case or surrounding space are the same name, not a synonym. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/** Every name an entity already answers to among `statements`: labels plus recorded aliases. */
function namesOf(iri: string, statements: readonly Statement[]): string[] {
  const out: string[] = [];
  for (const s of statements) {
    if (
      s.s.kind === 'iri' &&
      s.s.value === iri &&
      (s.p.value === RDFS_LABEL || s.p.value === SKOS_ALT_LABEL) &&
      s.o.kind === 'literal' &&
      isActive(s)
    ) {
      out.push(s.o.value);
    }
  }
  return out;
}

/**
 * Rewrite the label statements that normalization turned into conflicts, as pending aliases.
 *
 * Takes the statements as `normalizeEntities` returned them (subject IRIs already remapped),
 * the remaps it reported, and the graph they were normalized against. Returns a new statement
 * array — same length, same order, same ids — in which each doomed `rdfs:label` has become a
 * `skos:altLabel` marked `pending`.
 *
 * A label is converted only when ALL of the following hold, and left completely alone
 * otherwise:
 *
 *  - its subject is the TARGET of a subject remap, so this ingest genuinely folded something
 *    into it (a label on an untouched entity is not evidence of anything);
 *  - the target already carries an active `rdfs:label` with a different value, so keeping this
 *    one as a label really would produce the conflict described above. If the target has no
 *    name yet, this statement is giving it one — that is a label, not a synonym;
 *  - the target does not already answer to the name, whether by label or by an alias recorded
 *    earlier. Re-ingesting the same source must not append the same altLabel twice.
 *
 * Deliberately pure and id-preserving: the caller owns persistence, and reusing the incoming
 * statement's id means provenance, sourceId, extractionRunId and excerpt all travel with the
 * alias for free. The name keeps the citation that produced it.
 */
export function aliasesFromNormalization(
  statements: readonly Statement[],
  remaps: readonly SubjectRemap[],
  existing: readonly Statement[],
): { statements: Statement[]; conversions: AliasConversion[] } {
  const foldedInto = new Map<string, { from: string; similarity: number }>();
  for (const r of remaps) {
    if (r.kind !== 'subject') continue;
    // Several entities can fold into one target; keep the strongest evidence for the target.
    const prior = foldedInto.get(r.to);
    if (!prior || r.similarity > prior.similarity) {
      foldedInto.set(r.to, { from: r.from, similarity: r.similarity });
    }
  }
  if (foldedInto.size === 0) return { statements: [...statements], conversions: [] };

  // Names already spoken for, per target entity. Seeded from the pre-existing graph and grown
  // as we go, so two incoming labels with the same value do not both become aliases.
  const claimed = new Map<string, Set<string>>();
  const claimedFor = (iri: string): Set<string> => {
    let set = claimed.get(iri);
    if (!set) {
      set = new Set(namesOf(iri, existing).map(normalize));
      claimed.set(iri, set);
    }
    return set;
  };

  // Does the target already have a name of its own? Only then is a rival label a conflict.
  const hasOwnLabel = new Map<string, boolean>();
  const targetHasLabel = (iri: string): boolean => {
    let known = hasOwnLabel.get(iri);
    if (known === undefined) {
      known = existing.some(
        (s) =>
          s.s.kind === 'iri' &&
          s.s.value === iri &&
          s.p.value === RDFS_LABEL &&
          s.o.kind === 'literal' &&
          isActive(s),
      );
      hasOwnLabel.set(iri, known);
    }
    return known;
  };

  const conversions: AliasConversion[] = [];
  const out = statements.map((st) => {
    if (st.p.value !== RDFS_LABEL) return st;
    if (st.s.kind !== 'iri' || st.o.kind !== 'literal') return st;

    const fold = foldedInto.get(st.s.value);
    if (!fold) return st;
    if (!targetHasLabel(st.s.value)) return st;

    const value = st.o.value.trim();
    if (!value) return st;

    const names = claimedFor(st.s.value);
    const key = normalize(value);
    if (names.has(key)) return st;
    names.add(key);

    conversions.push({
      iri: st.s.value,
      value,
      fromIri: fold.from,
      similarity: fold.similarity,
    });

    return {
      ...st,
      p: { kind: 'iri' as const, value: SKOS_ALT_LABEL },
      o: { kind: 'literal' as const, value },
      confidence: fold.similarity,
      status: 'pending' as const,
    };
  });

  return { statements: out, conversions };
}
