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
  ARCHIVE_EVENT_PREFIX, ARC_SNAPSHOT_ITEM, archiveGraphName, archiveEntities,
  eventToStatements, snapshotToStatements, statementsToEvents, statementsToSnapshot,
  applyRetention,
  type ArchiveEventType, type ArchiveActor, type ArchiveEvent, type RetentionPolicy,
} from '$lib/rdf/archive';
import { getRegistry, createKb, updateKbEntry } from './kb-registry';
import type { Statement } from '$lib/rdf/types';

/** Registry id of the archive graph linked to `parentStableId`, if it exists. */
export function findArchiveKbId(parentStableId: string): string | null {
  return getRegistry().find((k) => k.archiveOf === parentStableId)?.id ?? null;
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
