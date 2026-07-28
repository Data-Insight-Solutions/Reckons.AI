/**
 * Archive store adapter (F97.1) — the only place that writes to TWO graphs at once.
 *
 * `rdf/archive.ts` holds the pure core: it decides WHAT moves and builds the journal entry, with
 * no Dexie and no clock. This module is the thin adapter that actually performs the move —
 * creating the "<parent> (archives)" graph on demand, writing the archived statements and the
 * journal event into it, and removing the moved statements from the working graph.
 *
 * THE ORDERING IS THE WHOLE DESIGN. A two-graph move has no transaction spanning both Dexie
 * databases, so a crash between the halves is possible and must be made SAFE rather than pretended
 * away. We therefore always:
 *
 *     1. write to the ARCHIVE first (additive, idempotent by statement id)
 *     2. only then delete from the WORKING graph
 *
 * A crash after step 1 leaves the facts in BOTH graphs — visibly duplicated, trivially
 * reconcilable, and nothing is lost. The opposite order would leave a window where the facts exist
 * nowhere. Given the choice between a recoverable mess and unrecoverable loss, this feature must
 * always pick the mess: silent destruction is the one failure the archive exists to prevent.
 */

import { KBaseDB } from './db';
import {
  ARCHIVE_EVENT_PREFIX, ARC_COMMITTED, ARC_SNAPSHOT_ITEM, archiveGraphName, archiveEntities,
  eventToStatements, snapshotToStatements, statementsToEvents, statementsToSnapshot,
  applyRetention, findArchivedReferences,
  type ArchiveEventType, type ArchiveActor, type ArchiveEvent, type RetentionPolicy,
  type ArchivedReference,
} from '$lib/rdf/archive';
import { getRegistry, createKb, updateKbEntry } from './kb-registry';
import type { Statement } from '$lib/rdf/types';

/** Registry id of the archive graph linked to `parentStableId`, if it exists. */
export function findArchiveKbId(parentStableId: string): string | null {
  return getRegistry().find((k) => k.archiveOf === parentStableId)?.id ?? null;
}

const isArchiveMetadataRow = (statement: Statement) =>
  statement.s.kind === 'iri' && statement.s.value.startsWith(ARCHIVE_EVENT_PREFIX);

async function loadArchiveRows(parentStableId: string): Promise<Statement[]> {
  if (!parentStableId.trim()) throw new Error('Archive parent stable ID is required');

  const archiveKbId = findArchiveKbId(parentStableId);
  if (!archiveKbId) return [];

  const db = new KBaseDB(archiveKbId);
  try {
    return await db.statements.toArray();
  } finally {
    db.close();
  }
}

/**
 * Load archived graph facts for one parent without exposing journal or snapshot wrapper rows.
 *
 * A parent with no archive is the ordinary first-run case, so it returns an empty set and does not
 * create a Dexie database. A blank stable ID is a caller bug: treating it as "no archive" would
 * silently disable the duplicate guard for an unidentified graph.
 *
 * Rejected and superseded facts stay in this result because this is a storage read, not a semantic
 * view. Consumers such as `findArchivedReferences` decide which statuses are live.
 */
export async function loadArchivedFacts(parentStableId: string): Promise<Statement[]> {
  return (await loadArchiveRows(parentStableId)).filter(
    (statement) => !isArchiveMetadataRow(statement),
  );
}

/**
 * Storage-backed half of F97.3. The eventual ingest UI can call this before committing extracted
 * facts, then offer a restore when matches exist; this function deliberately performs no mutation.
 */
export async function findArchivedReferencesForParent(
  parentStableId: string,
  incoming: Statement[],
): Promise<ArchivedReference[]> {
  const rows = await loadArchiveRows(parentStableId);
  const archivedFacts = rows.filter((statement) => !isArchiveMetadataRow(statement));
  const archivedEntities = currentlyArchivedEntities(statementsToEvents(rows));
  return findArchivedReferences(incoming, archivedFacts, archivedEntities);
}

function currentlyArchivedEntities(events: ArchiveEvent[]): Set<string> {
  const entityState = new Map<string, boolean>();
  // statementsToEvents is newest-first. The latest completed event touching an entity determines
  // whether it is currently archived. A prepared revert is deliberately NOT active yet.
  for (const event of events) {
    for (const entity of event.entities) {
      if (!entityState.has(entity)) {
        entityState.set(entity, event.type !== 'revert' || event.committed === false);
      }
    }
  }
  const archivedEntities = new Set(
    [...entityState].filter(([, archived]) => archived).map(([entity]) => entity),
  );
  return archivedEntities;
}

export class ArchivedEntityRestoreError extends Error {}
export class ArchivedStatementCollisionError extends Error {}

export interface RestoreArchivedEntityInput {
  /** Exact Dexie database name of the working graph. */
  workingKbId: string;
  /** Stable identity linking the working graph to its archive. */
  parentStableId: string;
  /** Exact archived entity IRI selected by the user. */
  entity: string;
  actor: ArchiveActor;
  note?: string;
  retentionPolicy?: RetentionPolicy;
  now?: () => number;
  newId?: () => string;
}

export interface RestoreArchivedEntityResult {
  event: ArchiveEvent;
  archiveKbId: string;
  /** Full-fidelity archive facts copied back into the working graph. */
  restored: Statement[];
  /** True when a completed retry found the same entity already restored. */
  alreadyRestored: boolean;
}

const touchesEntity = (statement: Statement, entity: string) =>
  (statement.s.kind === 'iri' && statement.s.value === entity)
  || (statement.o.kind === 'iri' && statement.o.value === entity);

const touchesArchivedPeer = (
  statement: Statement,
  entity: string,
  archivedEntities: Set<string>,
) =>
  (statement.s.kind === 'iri'
    && statement.s.value !== entity
    && archivedEntities.has(statement.s.value))
  || (statement.o.kind === 'iri'
    && statement.o.value !== entity
    && archivedEntities.has(statement.o.value));

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

const sameStatement = (left: Statement, right: Statement) =>
  stableSerialize(left) === stableSerialize(right);

function assertNoStatementCollisions(
  current: Statement[],
  restoring: Statement[],
): Statement[] {
  const byId = new Map(current.map((statement) => [statement.id, statement]));
  const missing: Statement[] = [];
  for (const statement of restoring) {
    const existing = byId.get(statement.id);
    if (!existing) {
      missing.push(statement);
    } else if (!sameStatement(existing, statement)) {
      throw new ArchivedStatementCollisionError(
        `Cannot restore archived statement "${statement.id}": the working graph uses that ID for different content.`,
      );
    }
  }
  return missing;
}

function isSnapshotOrRestoredState(
  current: Statement[],
  snapshot: Statement[],
  restoring: Statement[],
): boolean {
  const allowed = new Map(snapshot.map((statement) => [statement.id, statement]));
  for (const statement of restoring) {
    const existing = allowed.get(statement.id);
    if (existing && !sameStatement(existing, statement)) return false;
    allowed.set(statement.id, statement);
  }
  if (current.length !== allowed.size && current.length !== snapshot.length) return false;
  const currentById = new Map(current.map((statement) => [statement.id, statement]));
  const candidates = current.length === snapshot.length ? snapshot : [...allowed.values()];
  return candidates.every((statement) => {
    const existing = currentById.get(statement.id);
    return existing !== undefined && sameStatement(existing, statement);
  });
}

/**
 * Copy one currently archived entity back into its working graph.
 *
 * The archive facts remain in the archive as historical evidence. Current archive membership is
 * derived from the newest event for the entity, so a completed revert makes the retained copy
 * historical rather than live. Keeping it avoids a second destructive cross-database move.
 *
 * The durable three-step protocol is:
 *   1. archive DB: write a PREPARED revert event + full pre-restore working snapshot
 *   2. working DB: idempotently bulkPut the exact archived facts
 *   3. archive DB: atomically replace committed=false with committed=true, then apply retention
 *
 * Every crash leaves a complete archive copy. A crash after step 2 additionally leaves the working
 * copy and a recoverable prepared event whose original snapshot is still intact.
 */
export async function restoreArchivedEntityForParent(
  input: RestoreArchivedEntityInput,
): Promise<RestoreArchivedEntityResult> {
  if (!input.workingKbId?.trim()) throw new ArchivedEntityRestoreError('Working KB ID is required');
  if (!input.parentStableId?.trim()) {
    throw new ArchivedEntityRestoreError('Archive parent stable ID is required');
  }
  if (!input.entity?.trim()) throw new ArchivedEntityRestoreError('Archived entity IRI is required');

  const registry = getRegistry();
  const workingEntry = registry.find((entry) => entry.id === input.workingKbId);
  if (!workingEntry) {
    throw new ArchivedEntityRestoreError(`Working KB is not registered: ${input.workingKbId}`);
  }
  if (workingEntry.stableId !== input.parentStableId) {
    throw new ArchivedEntityRestoreError('Working KB ID does not match the parent stable ID');
  }

  const archiveKbId = findArchiveKbId(input.parentStableId);
  if (!archiveKbId) {
    throw new ArchivedEntityRestoreError('No archive graph exists for this parent');
  }
  if (archiveKbId === input.workingKbId) {
    throw new ArchivedEntityRestoreError('Archive and working KB IDs must be different');
  }

  const archiveReadDb = new KBaseDB(archiveKbId);
  let archiveRows: Statement[];
  try {
    archiveRows = await archiveReadDb.statements.toArray();
  } finally {
    archiveReadDb.close();
  }

  const events = statementsToEvents(archiveRows);
  const latest = events.find((event) => event.entities.includes(input.entity));
  if (!latest) {
    throw new ArchivedEntityRestoreError(
      `Archived entity "${input.entity}" has no journal event.`,
    );
  }
  if (latest.parentStableId && latest.parentStableId !== input.parentStableId) {
    throw new ArchivedEntityRestoreError(
      `Archived entity "${input.entity}" belongs to a different parent stable ID.`,
    );
  }

  const archivedEntities = currentlyArchivedEntities(events);
  const restoring = archiveRows.filter(
    (statement) =>
      !isArchiveMetadataRow(statement)
      && statement.status !== 'rejected'
      && statement.status !== 'superseded'
      && touchesEntity(statement, input.entity)
      // Restoring A must not revive A→B while B is still archived. Inbound/outbound edges to active
      // neighbours are restored; edges within a still-archived cluster wait for that peer.
      && !touchesArchivedPeer(statement, input.entity, archivedEntities),
  );
  if (restoring.length === 0) {
    throw new ArchivedEntityRestoreError(
      `Archived entity "${input.entity}" has no active facts to restore.`,
    );
  }

  const workingReadDb = new KBaseDB(input.workingKbId);
  let workingBefore: Statement[];
  let workingSourceIds: Set<string>;
  try {
    const [statements, sources] = await Promise.all([
      workingReadDb.statements.toArray(),
      workingReadDb.sources.toArray(),
    ]);
    workingBefore = statements;
    workingSourceIds = new Set(sources.map((source) => source.id));
  } finally {
    workingReadDb.close();
  }
  const missingSources = [...new Set(restoring.map((statement) => statement.sourceId))]
    .filter((sourceId) => !workingSourceIds.has(sourceId));
  if (missingSources.length > 0) {
    throw new ArchivedEntityRestoreError(
      `Cannot restore archived entity "${input.entity}": missing source record(s) ${missingSources.join(', ')}.`,
    );
  }
  assertNoStatementCollisions(workingBefore, restoring);

  if (latest.type === 'revert' && latest.committed !== false) {
    const missing = assertNoStatementCollisions(workingBefore, restoring);
    if (missing.length > 0) {
      throw new ArchivedEntityRestoreError(
        `Archive journal says "${input.entity}" was restored, but ${missing.length} fact(s) are missing from the working graph.`,
      );
    }
    return {
      event: latest,
      archiveKbId,
      restored: restoring,
      alreadyRestored: true,
    };
  }

  let prepared: ArchiveEvent;
  let preRestoreSnapshot: Statement[];
  if (latest.type === 'revert' && latest.committed === false) {
    if (
      latest.restoreScope !== 'entity'
      || latest.parentStableId !== input.parentStableId
      || latest.entities.length !== 1
      || latest.entities[0] !== input.entity
      || latest.statementCount !== restoring.length
    ) {
      throw new ArchivedEntityRestoreError(
        `Prepared restore for "${input.entity}" does not match this entity-restore request.`,
      );
    }
    prepared = { ...latest, snapshot: statementsToSnapshot(archiveRows, latest.id) };
    preRestoreSnapshot = prepared.snapshot!;
  } else {
    const at = (input.now ?? (() => Date.now()))();
    const id = (input.newId ?? (() => crypto.randomUUID()))();
    if (events.some((event) => event.id === id)) {
      throw new ArchivedEntityRestoreError(`Archive event ID already exists: ${id}`);
    }
    prepared = {
      id,
      type: 'revert',
      at,
      actor: input.actor,
      entities: [input.entity],
      statementCount: restoring.length,
      parentStableId: input.parentStableId,
      snapshot: workingBefore,
      note: input.note ?? `Restored archived entity ${input.entity}`,
      committed: false,
      restoreScope: 'entity',
    };
    preRestoreSnapshot = workingBefore;

    const archivePrepareDb = new KBaseDB(archiveKbId);
    try {
      await archivePrepareDb.transaction('rw', archivePrepareDb.statements, async () => {
        await archivePrepareDb.statements.bulkPut([
          ...eventToStatements(prepared),
          ...snapshotToStatements(prepared),
        ]);
      });
    } finally {
      archivePrepareDb.close();
    }
  }

  const workingWriteDb = new KBaseDB(input.workingKbId);
  try {
    await workingWriteDb.transaction('rw', workingWriteDb.statements, async () => {
      const current = await workingWriteDb.statements.toArray();
      if (!isSnapshotOrRestoredState(current, preRestoreSnapshot, restoring)) {
        throw new ArchivedEntityRestoreError(
          'Working graph changed after the restore was prepared; refusing to apply a stale snapshot contract.',
        );
      }
      const missing = assertNoStatementCollisions(current, restoring);
      if (missing.length > 0) await workingWriteDb.statements.bulkPut(missing);
    });
  } finally {
    workingWriteDb.close();
  }

  const committed: ArchiveEvent = { ...prepared, committed: true };
  const preparedMarker = eventToStatements(prepared)
    .find((statement) => statement.p.value === ARC_COMMITTED);
  if (!preparedMarker) throw new ArchivedEntityRestoreError('Prepared restore has no completion marker');

  const archiveCommitDb = new KBaseDB(archiveKbId);
  try {
    await archiveCommitDb.transaction('rw', archiveCommitDb.statements, async () => {
      await archiveCommitDb.statements.bulkDelete([preparedMarker.id]);
      await archiveCommitDb.statements.bulkPut([
        ...eventToStatements(committed),
        ...snapshotToStatements(committed),
      ]);
      await pruneSnapshotRows(
        archiveCommitDb,
        {
          ...input.retentionPolicy,
          // A restore whose undo snapshot disappears in the same operation is not reversible.
          keepLast: Math.max(1, input.retentionPolicy?.keepLast ?? 10),
        },
        committed.at,
      );
    });
  } finally {
    archiveCommitDb.close();
  }

  return {
    event: committed,
    archiveKbId,
    restored: restoring,
    alreadyRestored: false,
  };
}

/**
 * Get the archive graph for a parent, creating it on first use.
 *
 * Created lazily rather than alongside every graph: an archive that never receives anything is
 * clutter in the graph list, and the feature's whole purpose is reducing what the user has to look
 * at. `archiveOf` on the registry entry links it back to its parent by stable ID, so renaming the
 * parent cannot orphan its history or create a second archive.
 */
export function ensureArchiveKb(parentName: string, parentStableId: string): string {
  if (!parentStableId.trim()) throw new Error('Archive parent stable ID is required');

  const targetName = archiveGraphName(parentName);
  const registry = getRegistry();
  const linked = registry.find((k) => k.archiveOf === parentStableId);
  if (linked) {
    // Keep the display name in sync without using it as identity.
    if (linked.name !== targetName) updateKbEntry(linked.id, { name: targetName });
    return linked.id;
  }

  // Upgrade an archive created before stable-ID linking was enforced. Only adopt an unlinked or
  // name-linked row: a same-named archive linked to a different stable ID belongs to another graph.
  const legacy = registry.find(
    (k) => k.name === targetName && (k.archiveOf == null || k.archiveOf === parentName),
  );
  if (legacy) {
    updateKbEntry(legacy.id, { archiveOf: parentStableId });
    return legacy.id;
  }

  const entry = createKb(targetName);
  updateKbEntry(entry.id, { archiveOf: parentStableId });
  return entry.id;
}

export interface ArchiveRunInput {
  /** Statements currently in the working graph. */
  statements: Statement[];
  /** Entity IRIs to move out. */
  entities: string[];
  type: ArchiveEventType;
  actor: ArchiveActor;
  /** Exact Dexie database name of the working graph. Never inferred during a destructive write. */
  workingKbId: string;
  parentName: string;
  /** Stable identity used to find the same archive after a parent rename. */
  parentStableId: string;
  note?: string;
  milestone?: boolean;
  /** Bounded by default to the latest 10 snapshots plus milestones. */
  retentionPolicy?: RetentionPolicy;
  /** Injected for testability; defaults to the real clock and uuid. */
  now?: () => number;
  newId?: () => string;
}

export interface ArchiveRunResult {
  event: ArchiveEvent;
  archiveKbId: string;
  /** Statements remaining in the working graph after the move. */
  kept: Statement[];
  archivedCount: number;
}

/**
 * Perform an archive move against real storage.
 *
 * Returns the surviving statements so the caller can update its in-memory store; the working-graph
 * DELETE is done here so the ordering guarantee above is enforced in one place rather than trusted
 * to every call site.
 */
export async function runArchive(input: ArchiveRunInput): Promise<ArchiveRunResult> {
  if (!input.workingKbId?.trim()) throw new Error('Working KB ID is required');
  if (!input.parentStableId?.trim()) throw new Error('Archive parent stable ID is required');

  // A supplied database name is only safe if it is the registry entry carrying this stable ID.
  // Otherwise a typo would make Dexie create a new empty database: the archive write would succeed
  // while the real working graph stayed untouched, leaving persisted state and the caller's
  // in-memory `kept` result disagreeing. Reject the mismatch before creating an archive.
  const registry = getRegistry();
  const linkedArchive = registry.find((k) => k.archiveOf === input.parentStableId);
  if (linkedArchive?.id === input.workingKbId) {
    throw new Error('Archive and working KB IDs must be different');
  }
  const workingEntry = registry.find((k) => k.id === input.workingKbId);
  if (!workingEntry) throw new Error(`Working KB is not registered: ${input.workingKbId}`);
  if (workingEntry.stableId !== input.parentStableId) {
    throw new Error('Working KB ID does not match the parent stable ID');
  }

  const now = input.now ?? (() => Date.now());
  const newId = input.newId ?? (() => crypto.randomUUID());
  const at = now();

  const { kept, archived, event } = archiveEntities({
    statements: input.statements,
    entities: input.entities,
    type: input.type,
    actor: input.actor,
    at,
    eventId: newId(),
    parentStableId: input.parentStableId,
    milestone: input.milestone,
    note: input.note,
  });

  const archiveKbId = ensureArchiveKb(input.parentName, input.parentStableId);
  if (archiveKbId === input.workingKbId) {
    throw new Error('Archive and working KB IDs must be different');
  }

  // ── Step 1: write to the archive (additive) ────────────────────────────────
  const archiveDb = new KBaseDB(archiveKbId);
  try {
    // bulkPut, not bulkAdd: re-running an archive that partially completed must converge rather
    // than throw on the statements that already made it across.
    await archiveDb.statements.bulkPut([
      ...archived,
      ...eventToStatements(event),
      ...snapshotToStatements(event),
    ]);
    // Retention is part of the writer, not a maintenance task callers may forget. It runs before
    // the working graph is touched, so a retention failure leaves duplicated facts rather than
    // completing a destructive move without the promised storage bound.
    await pruneSnapshotRows(archiveDb, input.retentionPolicy, at);
  } finally {
    archiveDb.close();
  }

  // ── Step 2: only now remove from the working graph ─────────────────────────
  // If the process dies before this line, the facts are duplicated across both graphs. That is
  // the intended failure mode — recoverable, and visible.
  const workingDb = new KBaseDB(input.workingKbId);
  try {
    await workingDb.statements.bulkDelete(archived.map((s) => s.id));
  } finally {
    workingDb.close();
  }

  return { event, archiveKbId, kept, archivedCount: archived.length };
}

/** Load one exact pre-operation snapshot, failing loudly if it was pruned or corrupted. */
export async function loadArchiveSnapshot(
  archiveKbId: string,
  eventId: string,
): Promise<Statement[]> {
  const db = new KBaseDB(archiveKbId);
  try {
    return statementsToSnapshot(await db.statements.toArray(), eventId);
  } finally {
    db.close();
  }
}

async function pruneSnapshotRows(
  db: KBaseDB,
  policy: RetentionPolicy = {},
  now = Date.now(),
): Promise<{ droppedEvents: number; droppedStatements: number }> {
  const all = await db.statements.toArray();
  const { dropSnapshots } = applyRetention(statementsToEvents(all), policy, now);
  if (dropSnapshots.length === 0) return { droppedEvents: 0, droppedStatements: 0 };

  const ids = new Set(dropSnapshots.map((event) => event.id));
  const doomed = all.filter((statement) => {
    if (
      statement.s.kind !== 'iri'
      || statement.p.value !== ARC_SNAPSHOT_ITEM
      || !statement.s.value.startsWith(ARCHIVE_EVENT_PREFIX)
    ) return false;
    return ids.has(statement.s.value.slice(ARCHIVE_EVENT_PREFIX.length));
  });
  if (doomed.length > 0) await db.statements.bulkDelete(doomed.map((statement) => statement.id));
  const droppedEventIds = new Set(
    doomed.map((statement) => statement.s.value.slice(ARCHIVE_EVENT_PREFIX.length)),
  );
  return { droppedEvents: droppedEventIds.size, droppedStatements: doomed.length };
}

/**
 * Drop snapshot payloads that retention says are no longer needed.
 *
 * Only ever removes the bulky snapshot statements — the journal EVENTS stay forever. Losing the
 * record that something happened is a worse and less recoverable loss than losing the ability to
 * revert it, so this function cannot be used to erase history.
 */
export async function pruneArchiveSnapshots(
  archiveKbId: string,
  policy: RetentionPolicy = {},
  now = Date.now(),
): Promise<{ droppedEvents: number; droppedStatements: number }> {
  const db = new KBaseDB(archiveKbId);
  try {
    return pruneSnapshotRows(db, policy, now);
  } finally {
    db.close();
  }
}
