/**
 * Multi-graph store adapter (F91/F94) — open N graphs, and never hide the ones that failed.
 *
 * `rdf/multi-graph-query.ts` holds the pure merge rules. This is the thin adapter that reads the
 * registry, opens each graph's Dexie database, and hands the results over. It exists as its own
 * module for one reason: the failure mode of a federated read is a PARTIAL SUCCESS, and partial
 * success is the thing most easily mistaken for total success.
 *
 * WHY EVERY FAILURE IS CAPTURED RATHER THAN THROWN. If one graph's database is locked by another
 * tab, or was removed from disk while its registry row survived, throwing loses the four graphs
 * that answered perfectly well. Skipping it silently is worse: the caller renders a confident,
 * incomplete answer and nothing anywhere says so. So a graph that cannot be read becomes an
 * `UnavailableGraph` carried in the result, and `describeMultiGraphResult` refuses to describe an
 * answer without mentioning it.
 *
 * READ-ONLY, ALWAYS. Nothing here writes. A query that can mutate the graphs it is querying is a
 * different and much more dangerous thing, and the archive work in this repo already shows what a
 * multi-database write has to do to be safe (ordering guarantees, crash windows, retention).
 * Federated READ needs none of that and must not acquire it by accident.
 */

import { KBaseDB } from './db';
import { getRegistry, type KbEntry } from './kb-registry';
import type { GraphSource, UnavailableGraph } from '$lib/rdf/multi-graph-query';
import type { Statement } from '$lib/rdf/types';

export interface LoadGraphsOptions {
  /** Registry ids to read. Defaults to every registered graph. */
  ids?: string[];
  /** Exclude archive graphs. Default true — an archive answering beside its parent double-counts. */
  excludeArchives?: boolean;
  /** Hard cap on graphs opened in one query. Defaults to 25. */
  maxGraphs?: number;
}

export interface LoadedGraphs {
  graphs: GraphSource[];
  unavailable: UnavailableGraph[];
  /** True when `maxGraphs` stopped it short — reported, not silently applied. */
  capped: boolean;
}

/**
 * Open every requested graph and read its asserted statements.
 *
 * Graphs are opened SEQUENTIALLY rather than with `Promise.all`. Opening twenty-five IndexedDB
 * connections at once is how a browser tab stalls, and the ordering buys nothing here since the
 * merge is order-independent. Each database is closed in a `finally` so one failure cannot leak a
 * connection and wedge the next query.
 */
export async function loadGraphsForQuery(opts: LoadGraphsOptions = {}): Promise<LoadedGraphs> {
  const excludeArchives = opts.excludeArchives ?? true;
  const maxGraphs = opts.maxGraphs ?? 25;

  const registry = getRegistry();
  const wanted = opts.ids ? new Set(opts.ids) : null;

  let candidates: KbEntry[] = registry.filter((entry) => {
    if (wanted && !wanted.has(entry.id)) return false;
    // An archive holds a copy of facts that once lived in its parent. Letting it answer beside
    // its parent would present one fact as two graphs agreeing — precisely the false
    // corroboration `multi-graph-query.ts` computes independence to avoid.
    if (excludeArchives && entry.archiveOf) return false;
    return true;
  });

  const capped = candidates.length > maxGraphs;
  candidates = candidates.slice(0, maxGraphs);

  const graphs: GraphSource[] = [];
  const unavailable: UnavailableGraph[] = [];

  for (const entry of candidates) {
    let db: KBaseDB | null = null;
    try {
      db = new KBaseDB(entry.id);
      const all = await db.statements.toArray();
      graphs.push({
        id: entry.id,
        name: entry.name,
        statements: all.filter(isAsserted),
      });
    } catch (error) {
      unavailable.push({
        id: entry.id,
        name: entry.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      db?.close();
    }
  }

  return { graphs, unavailable, capped };
}

/** Mirrors the assertion rule in multi-graph-query.ts — a rejected fact is not an answer. */
function isAsserted(s: Statement): boolean {
  return s.status === 'confirmed' || s.status === 'refined';
}
