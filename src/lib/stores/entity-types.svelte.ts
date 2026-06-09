import {
  BUILT_IN_TYPES,
  UNKNOWN_TYPE,
  buildTypeMap,
  labelToIri,
  RDF_TYPE,
  RDFS_LABEL,
  KB_ENTITY_TYPE,
  KB_COLOR,
  KB_DESCRIPTION,
  KB_SCHEMA_PREDICATE,
  KB_ICON2D,
  KB_MESHY_TASK_ID,
  KB_MESHY_STATUS,
  type EntityTypeDef,
  type GeometryName
} from '../rdf/entity-types';
import { confirmedStatements, addStatements } from './kb.svelte';
import { glbOverrides } from './glb-overrides.svelte';
import type { Statement } from '../rdf/types';
import { v4 as uuid } from 'uuid';

/**
 * Reactive entity-type store.
 *
 * Built-in types are static. Custom types are derived live from confirmed
 * RDF statements (portable — they export with the KB).
 */

function n(value: string) { return { kind: 'iri' as const, value }; }
function l(value: string) { return { kind: 'literal' as const, value, datatype: 'http://www.w3.org/2001/XMLSchema#string' as string }; }

/** Derive custom EntityTypeDefs from confirmed RDF statements. */
function deriveCustomTypes(stmts: Statement[]): EntityTypeDef[] {
  // Find all subjects that are declared as EntityTypes
  const typeSubjects = new Set(
    stmts
      .filter((s) => s.p.value === RDF_TYPE && s.o.value === KB_ENTITY_TYPE)
      .map((s) => s.s.value)
  );

  const custom: EntityTypeDef[] = [];

  for (const subjectIri of typeSubjects) {
    // Skip built-in IRIs
    if (BUILT_IN_TYPES.some((t) => t.iri === subjectIri)) continue;

    const own = stmts.filter((s) => s.s.value === subjectIri);

    const label =
      own.find((s) => s.p.value === RDFS_LABEL)?.o.value ??
      subjectIri.split('/').pop() ??
      subjectIri;
    const color = own.find((s) => s.p.value === KB_COLOR)?.o.value ?? UNKNOWN_TYPE.color;
    const description = own.find((s) => s.p.value === KB_DESCRIPTION)?.o.value ?? '';
    const schemaPredicates = own
      .filter((s) => s.p.value === KB_SCHEMA_PREDICATE)
      .map((s) => s.o.value);

    // geometry stored in KB_ICON predicate as geometry name string
    const geometryRaw = own.find((s) => s.p.value === 'urn:kbase:predicate/icon')?.o.value;
    const geometry: GeometryName =
      (geometryRaw as GeometryName | undefined) ?? UNKNOWN_TYPE.geometry;

    const icon2d = own.find((s) => s.p.value === KB_ICON2D)?.o.value;
    const meshyTaskId = own.find((s) => s.p.value === KB_MESHY_TASK_ID)?.o.value;
    const meshyStatusRaw = own.find((s) => s.p.value === KB_MESHY_STATUS)?.o.value;
    const meshyStatus = meshyStatusRaw as EntityTypeDef['meshyStatus'] | undefined;

    // icon3d is now editor-level (stored in glbOverrides, not KB) — applied by allTypes()/typeMap()
    custom.push({ iri: subjectIri, label, geometry, color, description, schemaPredicates, builtIn: false, icon2d, meshyTaskId, meshyStatus });
  }

  return custom;
}

/** Apply editor-level GLB overrides to a list of types. */
function applyGlbOverrides(types: EntityTypeDef[]): EntityTypeDef[] {
  const overrides = glbOverrides();
  if (overrides.size === 0) return types;
  return types.map((t) => {
    const url = overrides.get(t.iri);
    return url ? { ...t, icon3d: url } : t;
  });
}

/** All known types (built-in + custom derived from KB), with editor GLB overrides applied. */
export function allTypes(): EntityTypeDef[] {
  const custom = deriveCustomTypes(confirmedStatements());
  return applyGlbOverrides([...BUILT_IN_TYPES, ...custom]);
}

/** O(1) IRI lookup map, with editor GLB overrides applied. */
export function typeMap(): Map<string, EntityTypeDef> {
  const custom = deriveCustomTypes(confirmedStatements());
  const map = buildTypeMap(custom);
  const overrides = glbOverrides();
  for (const [iri, url] of overrides) {
    const existing = map.get(iri);
    if (existing) map.set(iri, { ...existing, icon3d: url });
  }
  return map;
}

/** Resolve the type for a given subject IRI (from confirmed rdf:type statements). */
export function resolveType(subjectIri: string): EntityTypeDef {
  const stmts = confirmedStatements();
  const typeStmt = stmts.find(
    (s) => s.s.value === subjectIri && s.p.value === RDF_TYPE
  );
  if (!typeStmt) return UNKNOWN_TYPE;
  return typeMap().get(typeStmt.o.value) ?? UNKNOWN_TYPE;
}

/**
 * Emit confirmed RDF statements that define a new custom entity type.
 * The type becomes visible immediately because `allTypes()` is derived from
 * `confirmedStatements()`.
 */
export async function createCustomType(
  label: string,
  geometry: GeometryName,
  color: string,
  description: string,
  schemaPredicates: string[],
  icon2d?: string
): Promise<string> {
  const slug = labelToIri(label);
  const typeIri = `urn:kbase:type/${slug}`;
  const now = Date.now();
  const sourceId = 'user-defined';
  const g = n(`urn:kbase:source/user-defined`);
  const subject = n(typeIri);

  function litStmt(p: string, oValue: string): Statement {
    return {
      id: uuid(),
      s: subject,
      p: n(p),
      o: l(oValue),
      g,
      sourceId,
      confidence: 1,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now
    };
  }

  const stmts: Statement[] = [
    // Declare as EntityType
    {
      id: uuid(),
      s: subject,
      p: n(RDF_TYPE),
      o: n(KB_ENTITY_TYPE),
      g,
      sourceId,
      confidence: 1,
      status: 'confirmed',
      createdAt: now,
      updatedAt: now
    },
    litStmt(RDFS_LABEL, label),
    litStmt(KB_COLOR, color),
    litStmt(KB_DESCRIPTION, description),
    litStmt('urn:kbase:predicate/icon', geometry),
    ...schemaPredicates.map((p) => litStmt(KB_SCHEMA_PREDICATE, p)),
    ...(icon2d ? [litStmt(KB_ICON2D, icon2d)] : [])
  ];

  await addStatements(stmts);
  return typeIri;
}

/**
 * Upsert icon2d/meshy tracking fields on any type (built-in or custom).
 * Each field is stored as a confirmed RDF statement on the type IRI.
 * Existing statements for the same predicate are superseded.
 * NOTE: icon3d is now editor-level — use setGlb/clearGlb from glb-overrides.svelte.ts.
 */
export async function updateTypeIcons(
  typeIri: string,
  opts: { icon2d?: string; meshyTaskId?: string; meshyStatus?: string }
): Promise<void> {
  const { updateStatement, addStatements, statements: allStmts } = await import('./kb.svelte');
  const { v4: uuidFn } = await import('uuid');
  const now = Date.now();
  const g = { kind: 'iri' as const, value: 'urn:kbase:source/user-defined' };
  const subject = { kind: 'iri' as const, value: typeIri };

  const pairs: [string, string][] = [];
  if (opts.icon2d !== undefined) pairs.push([KB_ICON2D, opts.icon2d]);
  if (opts.meshyTaskId !== undefined) pairs.push([KB_MESHY_TASK_ID, opts.meshyTaskId]);
  if (opts.meshyStatus !== undefined) pairs.push([KB_MESHY_STATUS, opts.meshyStatus]);

  const existing = allStmts().filter((s) => s.s.value === typeIri);
  const toAdd: import('../rdf/types').Statement[] = [];

  for (const [pred, val] of pairs) {
    const old = existing.find((s) => s.p.value === pred);
    if (old) {
      await updateStatement(old.id, { status: 'superseded' });
    }
    if (val) {
      toAdd.push({
        id: uuidFn(),
        s: subject,
        p: { kind: 'iri', value: pred },
        o: { kind: 'literal', value: val, datatype: 'http://www.w3.org/2001/XMLSchema#string' },
        g,
        sourceId: 'user-defined',
        confidence: 1,
        status: 'confirmed',
        createdAt: now,
        updatedAt: now
      });
    }
  }
  if (toAdd.length) await addStatements(toAdd);
}

/**
 * Delete a custom entity type by rejecting all its defining statements.
 * Built-in types cannot be deleted.
 */
export async function deleteCustomType(iri: string): Promise<void> {
  if (BUILT_IN_TYPES.some((t) => t.iri === iri)) return;

  const { updateStatement, statements } = await import('./kb.svelte');

  const typeStmts = statements().filter((s) => s.s.value === iri);
  for (const st of typeStmts) {
    await updateStatement(st.id, { status: 'rejected' });
  }
}
