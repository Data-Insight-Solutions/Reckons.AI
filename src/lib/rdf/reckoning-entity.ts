import type { Source, Statement } from './types';
import { STMT_PREFIX, stmtIdFromIriPart, stmtIdToIriPart } from './types';
import { standingOf, type Standing } from './statement-standing';

/**
 * F223.12.1: a Reckoning is an entity the knowledge base keeps. The person chose a situation (facts, plus an
 * optional sentence), and that choice is a fact, so reloading the page, or coming back from the canvas,
 * restores it from the entity rather than from page memory.
 *
 * Like a Job entity (the Job entity module in src/lib/generation) it is the person's own act, so its rows are written
 * confirmed. It is a record of what was chosen and carries nothing executable.
 *
 * Each chosen fact is referenced by its reification IRI, urn:kbase:stmt/<id>, the same form the
 * Turtle file uses, so a Reckoning round-trips through a file.
 */
export const RECKONING_TYPE = 'urn:kbase:type/Reckoning';

const P = 'urn:kbase:predicate/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
export const RECKONING_PREDICATES = {
  situationStatement: `${P}situation-statement`,
  situationNote: `${P}situation-note`,
} as const;

export const reckoningEntity = (id: string) => `urn:kbase:concept/reckoning-${id}`;
export const reckoningSourceId = (id: string) => `reckoning-${id}`;
export const reckoningStatementIri = (statementId: string) => `${STMT_PREFIX}${stmtIdToIriPart(statementId)}`;
export const statementIdOfIri = (iri: string): string | null =>
  iri.startsWith(STMT_PREFIX) ? stmtIdFromIriPart(iri.slice(STMT_PREFIX.length)) : null;

export function reckoningSource(id: string, note: string, at: number): Source {
  return {
    id: reckoningSourceId(id), title: `Reckoning: ${(note.trim() || 'chosen statements').slice(0, 80)}`,
    uri: `note://reckoning/${id}`, kind: 'note', ingestedAt: at,
  };
}

const label = (note: string, count: number) =>
  `Reckoning: ${note.trim().slice(0, 60) || `${count} chosen statement${count === 1 ? '' : 's'}`}`;

/** Every row of one Reckoning. Ids are stable, so a later save differs only where the choice changed. */
export function reckoningStatements(id: string, statementIds: readonly string[], note: string, at: number): Statement[] {
  const entity = reckoningEntity(id);
  const sourceId = reckoningSourceId(id);
  const unique = [...new Set(statementIds)];
  const rows: Statement[] = [];
  const add = (key: string, predicate: string, value: string, iri = false) => {
    rows.push({
      id: `${sourceId}-${key}`, s: { kind: 'iri', value: entity }, p: { kind: 'iri', value: predicate },
      o: { kind: iri ? 'iri' : 'literal', value }, g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` },
      sourceId, status: 'confirmed', confidence: 1, createdAt: at, updatedAt: at,
    });
  };
  add('type', RDF_TYPE, RECKONING_TYPE, true);
  add('label', LABEL, label(note, unique.length));
  if (note.trim()) add('note', RECKONING_PREDICATES.situationNote, note.trim());
  for (const sid of unique) add(`sit-${stmtIdToIriPart(sid)}`, RECKONING_PREDICATES.situationStatement, reckoningStatementIri(sid), true);
  return rows;
}

export type ReadReckoning = { id: string; label: string; note: string; statementIds: string[] };

/** Read one Reckoning back. Null when no entity with that id has a Reckoning type row. */
export function readReckoning(all: readonly Statement[], id: string): ReadReckoning | null {
  const entity = reckoningEntity(id);
  const own = all.filter((s) => s.s.kind === 'iri' && s.s.value === entity && s.status !== 'rejected' && s.status !== 'superseded');
  if (!own.some((s) => s.p.value === RDF_TYPE && s.o.value === RECKONING_TYPE)) return null;
  const statementIds = own
    .filter((s) => s.p.value === RECKONING_PREDICATES.situationStatement)
    .map((s) => statementIdOfIri(s.o.value))
    .filter((v): v is string => v !== null);
  return {
    id,
    label: own.find((s) => s.p.value === LABEL)?.o.value ?? '',
    note: own.find((s) => s.p.value === RECKONING_PREDICATES.situationNote)?.o.value ?? '',
    statementIds,
  };
}

/** A new id for a Reckoning the person is starting. */
export const newReckoningId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** Facts a person can choose from: the Reckoning's own rows and job records are not situations. */
export function isChoosable(st: Statement): boolean {
  if (st.status === 'rejected' || st.status === 'superseded') return false;
  if (st.sourceId.startsWith('reckoning-') || st.sourceId.startsWith('job-')) return false;
  return st.p.value !== RDF_TYPE;
}

export type StandingGroup = { standing: Standing; label: string; statements: Statement[] };
const GROUPS: { standing: Standing; label: string }[] = [
  { standing: 'held', label: 'Held' },
  { standing: 'pending', label: 'Pending' },
  { standing: 'question', label: 'Questions' },
];

/** Choosable facts grouped by standing (held, pending, question), filtered by a search text. */
export function groupByStanding(
  all: readonly Statement[], query: string, labelOf: (iri: string) => string,
): StandingGroup[] {
  const q = query.trim().toLowerCase();
  const text = (st: Statement) => `${labelOf(st.s.value)} ${labelOf(st.p.value)} ${st.o.kind === 'iri' ? labelOf(st.o.value) : st.o.value}`;
  const pool = all.filter((st) => isChoosable(st) && (!q || text(st).toLowerCase().includes(q)));
  return GROUPS.map((g) => ({
    ...g,
    // proposed is pending that names an option; the list offers it with the pending ones
    statements: pool.filter((st) => { const s = standingOf(st); return g.standing === 'pending' ? s === 'pending' || s === 'proposed' : s === g.standing; }),
  })).filter((g) => g.statements.length > 0);
}

/** The facts that touch the given entities, offered as a situation when entities are picked on the canvas. */
export function statementsTouching(all: readonly Statement[], entityIris: ReadonlySet<string>, limit = 40): Statement[] {
  return all
    .filter((st) => isChoosable(st) && ((st.s.kind === 'iri' && entityIris.has(st.s.value)) || (st.o.kind === 'iri' && entityIris.has(st.o.value))))
    .sort((a, b) => Number(standingOf(a) !== 'held') - Number(standingOf(b) !== 'held'))
    .slice(0, limit);
}
