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
  archiveGraphName, archiveEntities, eventToStatements, applyRetention,
  type ArchiveEventType, type ArchiveActor, type ArchiveEvent, type RetentionPolicy,
} from '$lib/rdf/archive';
import { getRegistry, createKb, updateKbEntry } from './kb-registry';
import type { Statement } from '$lib/rdf/types';

/** Registry id of the archive graph belonging to `parentName`, if it exists. */
export function findArchiveKbId(parentName: string): string | null {
  const target = archiveGraphName(parentName);
  return getRegistry().find((k) => k.name === target)?.id ?? null;
}

/**
 * Get the archive graph for a parent, creating it on first use.
 *
 * Created lazily rather than alongside every graph: an archive that never receives anything is
 * clutter in the graph list, and the feature's whole purpose is reducing what the user has to look
 * at. `archiveOf` on the registry entry links it back to its parent.
 */
export function ensureArchiveKb(parentName: string, parentStableId?: string): string {
  const existing = findArchiveKbId(parentName);
  if (existing) return existing;

  const entry = createKb(archiveGraphName(parentName));
  updateKbEntry(entry.id, { archiveOf: parentStableId ?? parentName });
  return entry.id;
}

export interface ArchiveRunInput {
  /** Statements currently in the working graph. */
  statements: Statement[];
  /** Entity IRIs to move out. */
  entities: string[];
  type: ArchiveEventType;
  actor: ArchiveActor;
  parentName: string;
  parentStableId?: string;
  note?: string;
  milestone?: boolean;
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

  // ── Step 1: write to the archive (additive) ────────────────────────────────
  const archiveDb = new KBaseDB(archiveKbId);
  try {
    // bulkPut, not bulkAdd: re-running an archive that partially completed must converge rather
    // than throw on the statements that already made it across.
    await archiveDb.statements.bulkPut([...archived, ...eventToStatements(event)]);
  } finally {
    archiveDb.close();
  }

  // ── Step 2: only now remove from the working graph ─────────────────────────
  // If the process dies before this line, the facts are duplicated across both graphs. That is
  // the intended failure mode — recoverable, and visible.
  const workingDb = new KBaseDB();
  try {
    await workingDb.statements.bulkDelete(archived.map((s) => s.id));
  } finally {
    workingDb.close();
  }

  return { event, archiveKbId, kept, archivedCount: archived.length };
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
  events: ArchiveEvent[],
  policy: RetentionPolicy = {},
  now = Date.now(),
): Promise<{ droppedEvents: number; droppedStatements: number }> {
  const { dropSnapshots } = applyRetention(events, policy, now);
  if (dropSnapshots.length === 0) return { droppedEvents: 0, droppedStatements: 0 };

  const ids = new Set(dropSnapshots.map((e) => e.id));
  const db = new KBaseDB(archiveKbId);
  try {
    const all = await db.statements.toArray();
    // Snapshot statements are those provenance-linked to a dropped event; the event's own journal
    // triples live under urn:reckons:archive/event/<id> as the SUBJECT and are deliberately spared.
    const doomed = all.filter(
      (s) => ids.has(String(s.sourceId).replace(/^archive-snapshot:/, '')) &&
             String(s.sourceId).startsWith('archive-snapshot:'),
    );
    await db.statements.bulkDelete(doomed.map((s) => s.id));
    return { droppedEvents: dropSnapshots.length, droppedStatements: doomed.length };
  } finally {
    db.close();
  }
}
