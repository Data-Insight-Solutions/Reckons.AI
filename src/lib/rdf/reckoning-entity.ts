import type { Source, Statement } from './types';
import { STMT_PREFIX, stmtIdFromIriPart, stmtIdToIriPart } from './types';
import { standingOf, type Standing } from './statement-standing';
import type { TargetShape } from './proposal';

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
  situationStatement: 'urn:kbase:predicate/situation-statement',
  situationNote: `${P}situation-note`,
  /** F223.12.2: the question (an open fact) the person wants answered, by its reification IRI. */
  targetStatement: `${P}target-statement`,
  /** F223.12.2: the kind of asset to make (an Image, Video, Model3D or GaussianSplat type IRI). */
  targetAsset: `${P}target-asset`,
  /** F223.12.2: a written outcome, or the generation prompt that goes with an asset target. */
  targetNote: `${P}target-note`,
} as const;

/** Asset kinds a Reckoning can aim to make, in the order the target step offers them. */
export const TARGET_ASSET_TYPES = [
  { iri: 'urn:kbase:type/Image', label: 'Image' },
  { iri: 'urn:kbase:type/Video', label: 'Video' },
  { iri: 'urn:kbase:type/Model3D', label: '3D model' },
  { iri: 'urn:kbase:type/GaussianSplat', label: 'Gaussian splat' },
] as const;

/**
 * What the person is aiming at. At most one of statementId / assetType; `note` is free text on its own, or the
 * outcome or generation prompt that goes with the other two. All empty means no target chosen yet.
 */
export type ReckoningTarget = { statementId: string | null; assetType: string | null; note: string };
export const NO_TARGET: ReckoningTarget = { statementId: null, assetType: null, note: '' };

/** The entity the asset target stands for; it does not exist until the asset is made. */
export const targetAssetEntity = (id: string) => `urn:kbase:concept/reckoning-${id}-asset`;

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
export function reckoningStatements(
  id: string, statementIds: readonly string[], note: string, at: number, target: ReckoningTarget = NO_TARGET,
): Statement[] {
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
  // Only one of question or asset is kept; the note goes with either, or stands alone.
  if (target.statementId) add('target-statement', RECKONING_PREDICATES.targetStatement, reckoningStatementIri(target.statementId), true);
  else if (target.assetType) add('target-asset', RECKONING_PREDICATES.targetAsset, target.assetType, true);
  if (target.note.trim()) add('target-note', RECKONING_PREDICATES.targetNote, target.note.trim());
  return rows;
}

export type ReadReckoning = { id: string; label: string; note: string; statementIds: string[]; target: ReckoningTarget };

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
    target: {
      statementId: statementIdOfIri(own.find((s) => s.p.value === RECKONING_PREDICATES.targetStatement)?.o.value ?? ''),
      assetType: own.find((s) => s.p.value === RECKONING_PREDICATES.targetAsset)?.o.value ?? null,
      note: own.find((s) => s.p.value === RECKONING_PREDICATES.targetNote)?.o.value ?? '',
    },
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

export type StandingGroup = { standing: Standing; label: string; rows: Statement[] };
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
    rows: pool.filter((st) => { const s = standingOf(st); return g.standing === 'pending' ? s === 'pending' || s === 'proposed' : s === g.standing; }),
  })).filter((g) => g.rows.length > 0);
}

/** The facts that touch the given entities, offered as a situation when entities are picked on the canvas. */
export function statementsTouching(all: readonly Statement[], entityIris: ReadonlySet<string>, limit = 40): Statement[] {
  return all
    .filter((st) => isChoosable(st) && ((st.s.kind === 'iri' && entityIris.has(st.s.value)) || (st.o.kind === 'iri' && entityIris.has(st.o.value))))
    .sort((a, b) => Number(standingOf(a) !== 'held') - Number(standingOf(b) !== 'held'))
    .slice(0, limit);
}

/** Open questions a person can choose as the target: partial facts that are still live, held by no answer yet. */
export function questionTargets(all: readonly Statement[], query: string, labelOf: (iri: string) => string): Statement[] {
  const q = query.trim().toLowerCase();
  return all.filter((st) => {
    if (!isChoosable(st) || standingOf(st) !== 'question') return false;
    if (!q) return true;
    return `${labelOf(st.s.value)} ${labelOf(st.p.value)} ${st.question ?? ''}`.toLowerCase().includes(q);
  });
}

/**
 * The target as a TargetShape for the proposal (proposal.ts), or null when only free text was written (a written
 * outcome has no requirement a rule can check, so it never closes a proposal by itself).
 * Question: the question's subject and predicate must be held with any object, which an answer provides.
 * Asset: the asset entity must exist, typed as the chosen kind.
 * Null too when the chosen question is gone from the statements, so a stale choice cannot pass for a target.
 */
export function targetShapeFor(reckoning: Pick<ReadReckoning, 'id' | 'target'>, all: readonly Statement[]): TargetShape | null {
  const { statementId, assetType } = reckoning.target;
  const id = `reckoning-${reckoning.id}-target`;
  if (statementId) {
    const q = all.find((st) => st.id === statementId);
    if (!q || q.s.kind !== 'iri') return null;
    return { id, requirements: [{ s: q.s.value, p: q.p.value }] };
  }
  if (assetType) return { id, requirements: [{ s: targetAssetEntity(reckoning.id), p: RDF_TYPE, o: assetType }] };
  return null;
}
