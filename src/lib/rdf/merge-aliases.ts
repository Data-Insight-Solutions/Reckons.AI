/**
 * SYNONYMS SURVIVE A MERGE (Matt, 2026-08-13: "we need some way to track all synonyms within
 * a node. When merging multiple nodes into one that list should automatically occur.")
 *
 * THE PROBLEM THIS FIXES. Merging redirects every statement from the dropped entity onto the
 * kept one, and MergeReview treats two different `rdfs:label` values as a CONFLICT the user
 * must resolve — one wins, and the loser is set to `rejected`. So the moment you merge
 * "Ava Farmers Market" into "Ava Growers Market", the graph forgets it was ever called the
 * first thing. That name was real: it is what a source called it, what a search would look
 * for, and what the next import will arrive as — at which point the entity is duplicated
 * again and the same merge is done a second time by hand.
 *
 * A merge is a claim that two names denote ONE THING. Discarding the losing name throws away
 * precisely the evidence for that claim, and it is a lossy edit dressed up as a cleanup.
 *
 * WHY skos:altLabel AND NOT A NEW PREDICATE. SKOS is already the project's vocabulary for
 * concept relations — skos:broader and skos:narrower drive rdf/hierarchy.ts, skos:definition
 * appears in ghost-graph.ts and dichotomy.ts — and altLabel is SKOS's own term for exactly
 * this: alternate lexical labels for one concept, alongside a single prefLabel. Minting
 * kpred:synonym instead would be the private-vocabulary mistake graph-lint warns about
 * (73 of 315 predicates are used exactly once) and would not survive export to any other
 * tool. The primary name stays on rdfs:label; alternates accumulate as skos:altLabel.
 *
 * TRANSITIVITY IS FREE, and that is a consequence of using a plain statement rather than a
 * side table. Aliases live as statements whose subject is the kept entity, so a later merge
 * of that entity into a third one redirects them along with everything else. A merged three
 * times over still carries every name it has ever had, with no special handling.
 */

import { termKey, type Statement } from './types';
import { labelFromIRI } from './semantic-diff';

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const SKOS_ALT_LABEL = 'http://www.w3.org/2004/02/skos/core#altLabel';

/** Labels differing only by case or surrounding space are the same name, not a synonym. */
function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isActive(s: Statement): boolean {
  return s.status !== 'rejected' && s.status !== 'superseded';
}

/** Every name an entity currently answers to: its label(s) plus any alias already recorded. */
function namesOf(iri: string, statements: Statement[]): string[] {
  return statements
    .filter(
      (s) =>
        s.s.kind === 'iri' &&
        s.s.value === iri &&
        (s.p.value === RDFS_LABEL || s.p.value === SKOS_ALT_LABEL) &&
        s.o.kind === 'literal' &&
        isActive(s),
    )
    .map((s) => s.o.value);
}

/**
 * The alias values a merge of `dropIri` into `keepIri` should record on the kept entity.
 *
 * Includes the dropped entity's labels and any aliases it had already accumulated, plus the
 * name implied by its IRI — a node created as `urn:kbase:concept/ava-farmers-market` carries
 * a name in its identifier whether or not anyone wrote an rdfs:label for it, and dropping the
 * IRI silently drops that name too.
 *
 * `primaryLabel` is the value the merge keeps on rdfs:label. When the user resolves the label
 * conflict in favour of the DROPPED entity's name, the kept entity's original name is the one
 * about to be rejected, so it has to become an alias as well — otherwise the merge still
 * loses a name, just a different one.
 *
 * Returns values only, deduplicated case-insensitively and never including the primary label.
 * Deliberately pure: the caller owns Statement construction, ids and persistence, so this is
 * testable without a database.
 */
export function mergeAliasValues(
  keepIri: string,
  dropIri: string,
  statements: Statement[],
  primaryLabel?: string,
): string[] {
  const candidates = [
    ...namesOf(dropIri, statements),
    labelFromIRI(dropIri),
    ...namesOf(keepIri, statements),
    labelFromIRI(keepIri),
  ];

  const seen = new Set<string>();
  if (primaryLabel) seen.add(normalize(primaryLabel));

  const out: string[] = [];
  for (const raw of candidates) {
    const value = raw.trim();
    if (!value) continue;
    const key = normalize(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * Which alias values are genuinely NEW on the kept entity — i.e. not already recorded there.
 *
 * Kept separate from {@link mergeAliasValues} so a caller can show "3 names preserved" and
 * write only the statements that do not exist yet. Re-running a merge must not append the
 * same altLabel a second time.
 */
export function newAliasValues(
  keepIri: string,
  dropIri: string,
  statements: Statement[],
  primaryLabel?: string,
): string[] {
  const existing = new Set(namesOf(keepIri, statements).map(normalize));
  if (primaryLabel) existing.add(normalize(primaryLabel));
  return mergeAliasValues(keepIri, dropIri, statements, primaryLabel).filter(
    (v) => !existing.has(normalize(v)),
  );
}

/**
 * The label a merge should keep as the entity's primary name.
 *
 * Resolutions in MergeReview are keyed by the pair of statement ids and may pick the kept
 * entity's value, the dropped one's, or both. This resolves that to a single string so the
 * alias pass knows which name NOT to duplicate as an altLabel.
 */
export function primaryLabelAfterMerge(
  keepIri: string,
  statements: Statement[],
  rejectedIds: ReadonlySet<string>,
): string | undefined {
  const labels = statements.filter(
    (s) =>
      s.s.kind === 'iri' &&
      s.s.value === keepIri &&
      s.p.value === RDFS_LABEL &&
      s.o.kind === 'literal' &&
      isActive(s) &&
      !rejectedIds.has(s.id),
  );
  return labels[0]?.o.value;
}

/** Alias statements to persist, derived from an existing statement so provenance is carried. */
export function buildAliasStatements(
  keepIri: string,
  values: string[],
  template: Pick<Statement, 'g' | 'sourceId'>,
  makeId: () => string,
): Statement[] {
  const now = Date.now();
  return values.map((value) => ({
    id: makeId(),
    s: { kind: 'iri' as const, value: keepIri },
    p: { kind: 'iri' as const, value: SKOS_ALT_LABEL },
    o: { kind: 'literal' as const, value },
    g: template.g,
    sourceId: template.sourceId,
    confidence: 1.0,
    // Confirmed, not pending: the human already settled the merge that produced it, so
    // queueing the alias for a second review would be asking the same question twice.
    status: 'confirmed' as const,
    createdAt: now,
    updatedAt: now,
  }));
}

/** True when `iri` answers to `name` under any of its labels or aliases. */
export function entityAnswersTo(iri: string, name: string, statements: Statement[]): boolean {
  const target = normalize(name);
  return (
    namesOf(iri, statements).some((n) => normalize(n) === target) ||
    normalize(labelFromIRI(iri)) === target
  );
}

/** termKey re-export keeps callers from importing two modules for one merge operation. */
export { termKey };
