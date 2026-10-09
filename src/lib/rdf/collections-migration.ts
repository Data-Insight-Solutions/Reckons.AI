/**
 * F65 entity sets -> skos:Collection (0.2.6).
 *
 * Matt, 2026-10-08: a COLLECTION is the one grouping primitive (`skos:Collection` + `skos:member`).
 * `buildEntitySet` already writes that form (since 2026-09-11); data created before then still
 * carry `ktype:EntitySet` + `kpred:has-member`. This rewrites exactly those two terms and nothing
 * else, so everything a person grouped can appear in the collection layout.
 *
 * Pure: no storage, no clock. The caller persists `changed`. Idempotent: migrated data contains
 * neither legacy term, so a second run returns `changed: []`.
 *
 * WEAKNESS: ids are kept, so a legacy row whose rewrite equals a row that already exists becomes a
 * duplicate triple rather than being merged. Harmless to readers (they dedupe by IRI), but it is
 * not collapsed here because deleting a person's rows is a bigger act than this migration claims.
 */
import type { Statement } from './types';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const LEGACY_TYPE = 'urn:kbase:type/EntitySet';
const LEGACY_MEMBER = 'urn:kbase:predicate/has-member';

export interface CollectionsMigration {
  /** The full statement list with legacy terms rewritten (same order, same length). */
  statements: Statement[];
  /** Only the rows that were rewritten — what a caller must write back. */
  changed: Statement[];
}

export function migrateEntitySetsToCollections(statements: Statement[]): CollectionsMigration {
  const changed: Statement[] = [];
  const out = statements.map((st) => {
    if (st.p.value === RDF_TYPE && st.o.kind === 'iri' && st.o.value === LEGACY_TYPE) {
      const next = { ...st, o: { ...st.o, value: `${SKOS}Collection` } };
      changed.push(next);
      return next;
    }
    if (st.p.value === LEGACY_MEMBER) {
      const next = { ...st, p: { ...st.p, value: `${SKOS}member` } };
      changed.push(next);
      return next;
    }
    return st;
  });
  return { statements: out, changed };
}
