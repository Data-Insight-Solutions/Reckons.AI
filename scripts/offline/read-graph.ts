/**
 * Read a TTL file as Statements, for offline scripts that reason over a graph with the app's own
 * modules (F139).
 *
 * Shared because two scripts already needed the identical shim and a third will. The fields it
 * fabricates are the ones a FILE cannot carry — a review status where none is recorded — and that
 * is the honest limit to keep in mind when reading these reports: they analyse the graph as
 * WRITTEN, not the review state of a live workspace. Anything that depends on real `status` or
 * `proposedBy` must read the queue or the app database instead.
 *
 * IT DELEGATES TO THE APP'S OWN IMPORTER, AND THAT IS THE WHOLE POINT. An earlier version mapped
 * raw N3 quads 1:1 onto Statements. That is roughly right for a hand-authored graph and badly
 * wrong for one the app exported, because an exported graph carries every fact as an rdf:Statement
 * reification block that the importer FOLDS BACK into Statement fields. Measured 2026-09-02 on
 * reckons-workspace/kbs/personal-notes/personal-notes.ttl: the file declares 217 statements and the
 * quad map produced 2,295 — a 10.6x inflation — because it counted the bookkeeping as content.
 * This is the third recorded instance of the same error (HANDOFF records learning it twice in one
 * day), so the rule is now structural rather than remembered: MEASURE THE GRAPH THE APP BUILDS,
 * and the only way to be sure of that is to build it with the app's code.
 *
 * The same bug also destroyed provenance. Every statement was stamped `sourceId: <the file path>`,
 * so the F139.1 same-source cascade basis saw one gigantic source and proposed a single question
 * to settle 944 facts — a rubber stamp, and one that starved the agent tier of every fact it was
 * meant to judge. The importer recovers the REAL per-note sources from prov:wasDerivedFrom.
 */
import { readFileSync } from 'fs';
import { importTurtleFull } from '../../src/lib/rdf/import-ttl.js';
import type { Statement } from '../../src/lib/rdf/types.js';

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

export interface ReadGraph {
  statements: Statement[];
  /** subject IRI -> rdf:type, so F88 authority reservations resolve. */
  typeOf: (iri: string) => string | undefined;
  /**
   * True when the file carried no reification, so every statement was imported as a plain triple
   * and its `sourceId` is the synthetic literal `imported` rather than a real act of ingest.
   * Callers that reason about PROVENANCE must check this: clustering on a synthetic source is how
   * "do you trust this source?" became one question covering an entire file.
   */
  syntheticSource: boolean;
}

/**
 * `asReviewSet` marks every statement `pending` so a committed file can be inspected AS IF it were
 * a review queue. It must be opt-in and named: buildReviewTree deliberately ignores settled facts,
 * and an earlier version of this tooling defaulted the other way and reported 1,641 outstanding
 * review items on a graph that had none.
 */
export async function readGraph(
  file: string,
  opts: { asReviewSet?: boolean } = {},
): Promise<ReadGraph> {
  const turtle = readFileSync(file, 'utf8');
  const { statements: imported, cleanImportCount } = await importTurtleFull(turtle);

  // A clean import means there were no reification blocks: the importer minted random UUIDs for
  // ids and stamped every sourceId `imported`. Offline jobs derive stable cluster ids from
  // statement ids and re-run across commits, so a random id would make the same cluster look new
  // on every read. Re-stamp deterministically from position, which is what the old shim did well.
  const syntheticSource = cleanImportCount > 0;
  const statements = imported.map((st, i) => ({
    ...st,
    ...(syntheticSource ? { id: `${file}#${i}`, createdAt: i, updatedAt: i } : {}),
    ...(opts.asReviewSet ? { status: 'pending' as const } : {}),
  })) as Statement[];

  const types = new Map<string, string>();
  for (const st of statements) {
    if (st.p.value === RDF_TYPE) types.set(st.s.value, st.o.value);
  }

  return { statements, typeOf: (iri: string) => types.get(iri), syntheticSource };
}
