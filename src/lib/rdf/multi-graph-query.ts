/**
 * Multi-graph query (F91/F94) — one question, several graphs, answers that say where they came from.
 *
 * WHAT EXISTED BEFORE. `loadKbStatements()` reads ONE foreign graph whole. `cross-kb-align.ts`
 * compares exactly TWO. `question-router.ts` ranks which graph could answer but takes its
 * candidates already loaded, so something else had to do the reading. There was no primitive for
 * "ask this of every graph I have and merge the results", which is why the only cross-graph
 * action a user can take today is to LEAVE the graph they are in (`kb-leap.ts` → `switchToKb`).
 *
 * Everything here is PURE — graphs in, result out, no Dexie. The adapter that opens databases is
 * `multi-graph-store.ts`; keeping the merge rules testable without IndexedDB is what lets the
 * conflict and independence logic below be pinned properly.
 *
 * THREE RULES, each preventing a specific silent failure:
 *
 * 1. A GRAPH THAT COULD NOT BE READ IS NAMED. The classic federation bug is returning "no
 *    results" when the truth is "three of your five graphs failed to open". Those are opposite
 *    answers and they look identical. `unavailable` is part of the result, not a log line.
 *
 * 2. AGREEMENT IS NOT AUTOMATICALLY CORROBORATION. Two graphs asserting the same fact is only
 *    evidence if they arrived at it INDEPENDENTLY. If both facts trace to the same `sourceId`,
 *    one graph was copied from the other (or both from a third), and counting that as two
 *    confirmations is the thesis violated exactly: an unverifiable claim, made by the party it
 *    benefits, is not evidence — and a source you control yourself is not a source. So agreement
 *    is reported with its independence explicitly computed, never assumed.
 *
 * 3. DISAGREEMENT SURFACES, IT IS NEVER MERGED AWAY. Same subject and predicate, different
 *    object, in two graphs, is the most valuable thing a multi-graph query can find — it is the
 *    only way the federation can see a contradiction no single graph can. Picking a winner would
 *    destroy precisely the finding. This is `dichotomy.ts`'s conflict/dichotomy distinction,
 *    applied across graphs rather than within one.
 */

import type { Statement } from './types';

export interface GraphSource {
  id: string;
  name: string;
  statements: Statement[];
}

/** A graph that was asked but could not answer, and why. Never dropped from the result. */
export interface UnavailableGraph {
  id: string;
  name: string;
  reason: string;
}

export interface FactHit {
  statement: Statement;
  graphId: string;
  graphName: string;
}

/** The same subject+predicate holding DIFFERENT objects in different graphs. */
export interface CrossGraphConflict {
  subject: string;
  predicate: string;
  values: Array<{ object: string; graphId: string; graphName: string }>;
}

/** The same fact asserted in more than one graph. */
export interface CrossGraphAgreement {
  subject: string;
  predicate: string;
  object: string;
  graphs: Array<{ graphId: string; graphName: string; sourceId: string }>;
  /**
   * True only when no two agreeing graphs share a `sourceId`.
   *
   * When false, the graphs are repeating one source rather than confirming each other, and the
   * agreement carries no more weight than the single assertion underneath it.
   */
  independent: boolean;
}

export interface EntityAnswer {
  iri: string;
  label: string;
  /** Graphs that know this entity at all. */
  graphs: string[];
  facts: FactHit[];
  conflicts: CrossGraphConflict[];
  agreements: CrossGraphAgreement[];
}

export interface MultiGraphResult {
  answers: EntityAnswer[];
  /** Graph ids actually searched. */
  searched: string[];
  unavailable: UnavailableGraph[];
  /** True when `limit` cut the answers short — so a partial answer is never mistaken for all of it. */
  truncated: boolean;
}

export interface MultiGraphQuery {
  /** Free text matched against labels and literal objects, case-insensitively. */
  text?: string;
  /** Exact entity IRIs to look up. Combined with `text` as a union, not an intersection. */
  entities?: string[];
  /** Max entities returned. Defaults to 50 — a bound is the difference between a query and a load. */
  limit?: number;
}

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KPRED_NAME = 'urn:kbase:predicate/name';

/** Statuses that carry no assertion — a rejected fact is not this graph's answer to anything. */
function isAsserted(s: Statement): boolean {
  return s.status === 'confirmed' || s.status === 'refined';
}

function labelOf(statements: Statement[], iri: string): string {
  for (const s of statements) {
    if (s.s.kind === 'iri' && s.s.value === iri && s.o.kind === 'literal'
      && (s.p.value === RDFS_LABEL || s.p.value === KPRED_NAME)) {
      return s.o.value;
    }
  }
  return '';
}

/**
 * Ask every supplied graph one question and merge the answers.
 *
 * `unavailable` is passed IN rather than discovered here because this function is pure: the
 * adapter knows which databases failed to open. It is threaded through to the result so a caller
 * physically cannot render an answer without also having the list of graphs that did not
 * contribute to it.
 */
export function queryGraphs(
  graphs: GraphSource[],
  query: MultiGraphQuery,
  unavailable: UnavailableGraph[] = [],
): MultiGraphResult {
  const limit = query.limit ?? 50;
  const needle = query.text?.trim().toLowerCase() ?? '';
  const wanted = new Set(query.entities ?? []);

  // ── Which entities match, and in which graphs ──────────────────────────────
  const matched = new Map<string, Set<string>>(); // entity IRI -> graph ids
  for (const graph of graphs) {
    for (const s of graph.statements) {
      if (!isAsserted(s)) continue;
      if (s.s.kind !== 'iri') continue;

      const hitByEntity = wanted.has(s.s.value)
        || (s.o.kind === 'iri' && wanted.has(s.o.value));
      const hitByText = needle !== '' && (
        s.s.value.toLowerCase().includes(needle)
        || (s.o.kind === 'literal' && s.o.value.toLowerCase().includes(needle))
      );
      if (!hitByEntity && !hitByText) continue;

      // An IRI matched as an OBJECT is an answer about THAT entity, so record it there too.
      const subjects = [s.s.value];
      if (s.o.kind === 'iri' && wanted.has(s.o.value)) subjects.push(s.o.value);
      for (const iri of subjects) {
        if (!matched.has(iri)) matched.set(iri, new Set());
        matched.get(iri)!.add(graph.id);
      }
    }
  }

  // Entities known to the MOST graphs first: a fact several graphs hold is the more interesting
  // answer to a federated question, and it is where conflicts live.
  const ranked = [...matched.entries()]
    .sort(([aIri, aG], [bIri, bG]) => bG.size - aG.size || aIri.localeCompare(bIri));
  const truncated = ranked.length > limit;

  const answers: EntityAnswer[] = ranked.slice(0, limit).map(([iri, graphIds]) => {
    const facts: FactHit[] = [];
    let label = '';

    for (const graph of graphs) {
      if (!graphIds.has(graph.id)) continue;
      if (!label) label = labelOf(graph.statements, iri);
      for (const s of graph.statements) {
        if (!isAsserted(s)) continue;
        const touches = (s.s.kind === 'iri' && s.s.value === iri)
          || (s.o.kind === 'iri' && s.o.value === iri);
        if (touches) facts.push({ statement: s, graphId: graph.id, graphName: graph.name });
      }
    }

    return {
      iri,
      label,
      graphs: [...graphIds].sort(),
      facts,
      conflicts: findConflicts(facts, iri),
      agreements: findAgreements(facts, iri),
    };
  });

  return {
    answers,
    searched: graphs.map((g) => g.id).sort(),
    unavailable,
    truncated,
  };
}

/**
 * Same subject and predicate, different object, in different graphs.
 *
 * Only reported when the disagreeing graphs are actually different — one graph holding two values
 * for a predicate is a within-graph dichotomy, which `dichotomy.ts` already handles and which is
 * frequently legitimate (a person with two email addresses). Across graphs it is a contradiction
 * the federation can see and no member can.
 */
function findConflicts(facts: FactHit[], subject: string): CrossGraphConflict[] {
  const byPredicate = new Map<string, Map<string, { graphId: string; graphName: string }>>();

  for (const hit of facts) {
    const s = hit.statement;
    if (s.s.kind !== 'iri' || s.s.value !== subject) continue;
    const object = s.o.value;
    if (!byPredicate.has(s.p.value)) byPredicate.set(s.p.value, new Map());
    // Keyed by graph+object so one graph asserting two values does not read as a conflict.
    byPredicate.get(s.p.value)!.set(`${hit.graphId} ${object}`, {
      graphId: hit.graphId, graphName: hit.graphName,
    });
  }

  const conflicts: CrossGraphConflict[] = [];
  for (const [predicate, entries] of byPredicate) {
    const values = [...entries.entries()].map(([key, meta]) => ({
      object: key.split(' ')[1], ...meta,
    }));
    const distinctObjects = new Set(values.map((v) => v.object));
    const distinctGraphs = new Set(values.map((v) => v.graphId));
    if (distinctObjects.size > 1 && distinctGraphs.size > 1) {
      conflicts.push({
        subject,
        predicate,
        values: values.sort((a, b) => a.graphId.localeCompare(b.graphId) || a.object.localeCompare(b.object)),
      });
    }
  }
  return conflicts.sort((a, b) => a.predicate.localeCompare(b.predicate));
}

/**
 * The same fact in more than one graph, with independence computed rather than assumed.
 *
 * `independent` is false when two agreeing graphs share a `sourceId` — they are repeating one
 * source, not confirming each other, and presenting that as two confirmations would be the
 * project's own thesis violated in the one place it matters most.
 */
function findAgreements(facts: FactHit[], subject: string): CrossGraphAgreement[] {
  const byTriple = new Map<string, Map<string, { graphName: string; sourceId: string }>>();

  for (const hit of facts) {
    const s = hit.statement;
    if (s.s.kind !== 'iri' || s.s.value !== subject) continue;
    const key = `${s.p.value} ${s.o.value}`;
    if (!byTriple.has(key)) byTriple.set(key, new Map());
    byTriple.get(key)!.set(hit.graphId, { graphName: hit.graphName, sourceId: s.sourceId });
  }

  const agreements: CrossGraphAgreement[] = [];
  for (const [key, graphMap] of byTriple) {
    if (graphMap.size < 2) continue;
    const [predicate, object] = key.split(' ');
    const graphs = [...graphMap.entries()]
      .map(([graphId, meta]) => ({ graphId, ...meta }))
      .sort((a, b) => a.graphId.localeCompare(b.graphId));
    const sourceIds = new Set(graphs.map((g) => g.sourceId));
    agreements.push({
      subject,
      predicate,
      object,
      graphs,
      independent: sourceIds.size === graphs.length,
    });
  }
  return agreements.sort((a, b) => a.predicate.localeCompare(b.predicate));
}

/**
 * One honest sentence about a federated answer — including what did NOT answer.
 *
 * Written here so the caveat travels with the number. "12 results across 4 graphs" is true and
 * misleading if two more graphs failed to open and the reader was never told.
 */
export function describeMultiGraphResult(result: MultiGraphResult): string {
  const conflicts = result.answers.reduce((n, a) => n + a.conflicts.length, 0);
  const parts = [
    `${result.answers.length} result${result.answers.length === 1 ? '' : 's'} `
    + `from ${result.searched.length} graph${result.searched.length === 1 ? '' : 's'}.`,
  ];
  if (result.truncated) parts.push('More matched than were returned.');
  if (conflicts > 0) {
    parts.push(`${conflicts} disagreement${conflicts === 1 ? '' : 's'} between graphs.`);
  }
  if (result.unavailable.length > 0) {
    // Deliberately last and unambiguous: this is the sentence that stops a partial answer being
    // read as a complete one.
    parts.push(
      `${result.unavailable.length} graph${result.unavailable.length === 1 ? '' : 's'} could not be read `
      + `(${result.unavailable.map((u) => u.name || u.id).join(', ')}), so this answer is incomplete.`,
    );
  }
  return parts.join(' ');
}
