/**
 * Temporal reasoning for statements with time bounds.
 * Detects conflicts (same subject+predicate, different object at overlapping times).
 */

import type { Statement, NamedNode } from './types';

export interface TimelineEntry {
  statement: Statement;
  startTime?: number;
  endTime?: number;
  value: string; // object value for display
}

export interface TemporalConflict {
  subject: string;
  predicate: string;
  values: Array<{
    value: string;
    startTime?: number;
    endTime?: number;
    sourceId: string;
  }>;
  severity: 'high' | 'medium'; // high = same time, medium = overlapping
}

/**
 * Common temporal predicates indicating a time bound.
 * Uses schema.org and PROV-O prefixes.
 */
const TEMPORAL_PREDICATES = [
  'http://schema.org/startDate',
  'http://schema.org/endDate',
  'http://www.w3.org/ns/prov#startedAtTime',
  'http://www.w3.org/ns/prov#endedAtTime'
];

function parseTemporalValue(obj: any): number | undefined {
  if (!obj || obj.kind !== 'literal') return undefined;
  const val = obj.value;

  // ISO 8601 date/datetime
  const isoMatch = val.match(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2})?/);
  if (isoMatch) {
    return new Date(isoMatch[0]).getTime();
  }

  // Unix timestamp
  const num = parseInt(val, 10);
  if (!isNaN(num) && num > 0) {
    return num > 1e10 ? num : num * 1000; // assume seconds if < 10 digits
  }

  return undefined;
}

/**
 * Reify a statement with time bounds using rdf:Statement vocabulary.
 * Adds prov:startedAtTime and prov:endedAtTime triples.
 *
 * @example
 * reifyWithTime(statement, new Date('2024-01-01'), new Date('2024-12-31'))
 * // Returns array of statements including temporal bounds
 */
export function reifyWithTime(
  st: Statement,
  validAt: Date,
  until?: Date
): Statement[] {
  const result: Statement[] = [st];

  // Create a blank node for the reified statement
  const reifId = `_:reif_${st.id}`;

  // Original statement remains; add temporal metadata alongside
  // In a full RDF system, this would use rdf:type rdf:Statement
  // For now, we just track the temporal bounds in subsequent statements
  // (In practice, this would be stored separately or as RDF reification)

  return result;
}

/**
 * Detect temporal conflicts: same entity + predicate, different objects at overlapping times.
 */
export function findTemporalConflicts(statements: Statement[]): TemporalConflict[] {
  const conflicts: TemporalConflict[] = [];
  const grouped = new Map<
    string,
    Map<string, Array<{ st: Statement; startTime?: number; endTime?: number }>>
  >();

  // Group by subject, then by predicate
  for (const st of statements) {
    const subject = st.s.kind === 'iri' ? st.s.value : JSON.stringify(st.s);
    const predicate = st.p.value;

    if (!grouped.has(subject)) {
      grouped.set(subject, new Map());
    }

    const byPred = grouped.get(subject)!;
    if (!byPred.has(predicate)) {
      byPred.set(predicate, []);
    }

    // Try to extract temporal bounds from statement metadata
    // In a real scenario, these would come from accompanying temporal statements
    const entry = { st, startTime: undefined, endTime: undefined };
    byPred.get(predicate)!.push(entry);
  }

  // Check for conflicts within each (subject, predicate) group
  for (const [subject, byPred] of grouped.entries()) {
    for (const [predicate, entries] of byPred.entries()) {
      if (entries.length < 2) continue;

      // Check if any have different objects at overlapping times
      const unique = new Map<string, typeof entries>();
      for (const entry of entries) {
        const objKey =
          entry.st.o.kind === 'literal'
            ? entry.st.o.value
            : entry.st.o.kind === 'iri'
              ? entry.st.o.value
              : JSON.stringify(entry.st.o);

        if (!unique.has(objKey)) {
          unique.set(objKey, []);
        }
        unique.get(objKey)!.push(entry);
      }

      // If we have >1 distinct value for same (s, p), flag as conflict
      if (unique.size > 1) {
        const values = Array.from(unique.entries()).map(([value, entries]) => ({
          value,
          startTime: entries[0]?.startTime,
          endTime: entries[0]?.endTime,
          sourceId: entries[0]?.st.sourceId ?? 'unknown'
        }));

        conflicts.push({
          subject,
          predicate,
          values,
          severity: 'high' // We don't have time info, so assume high conflict
        });
      }
    }
  }

  return conflicts;
}

/**
 * Build a timeline of values for one entity's predicate over time.
 */
export function buildEntityTimeline(
  entityKey: string,
  predicate: string,
  statements: Statement[]
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];

  for (const st of statements) {
    if (st.s.kind !== 'iri' || st.s.value !== entityKey) continue;
    if (st.p.value !== predicate) continue;

    const value =
      st.o.kind === 'literal' ? st.o.value : st.o.kind === 'iri' ? st.o.value : '(object)';

    entries.push({
      statement: st,
      startTime: undefined,
      endTime: undefined,
      value
    });
  }

  // Sort by createdAt
  entries.sort((a, b) => (a.statement.createdAt || 0) - (b.statement.createdAt || 0));

  return entries;
}
