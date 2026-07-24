/**
 * Archive journal (F97.1) — the graph's edit history, kept as a graph.
 *
 * When a destructive operation runs on a graph (delete, merge, prune sweep, age-drop), the facts
 * do not disappear: they move to a SEPARATE archive graph named "<parent> (archives)", and the
 * operation itself is recorded as a journalled EVENT carrying a full pre-operation snapshot. That
 * is what makes the working graph smaller AND makes the change reversible — the two things the
 * feature has to do at once.
 *
 * WHY A SEPARATE GRAPH, not an `archived` flag: a flag only hides facts from a view; they still
 * load, still embed, still count. Moving them to another graph is what actually reduces node count,
 * which is the whole motivation.
 *
 * WHY FULL SNAPSHOTS (Matt's call, 2026-07-18): revert becomes trivially correct and time-travel
 * becomes cheap to compute. The accepted cost is storage that grows with graph size × operation
 * count — which cuts directly against the node-count goal. So RETENTION IS LOAD-BEARING and lives
 * in this same module rather than arriving later: a snapshot writer with no bound would trade a
 * node-count problem for a bigger storage problem and call it an improvement.
 *
 * Everything here is PURE and model-free — statements in, statements out, no Dexie and no clock
 * except what the caller passes. That keeps the journal testable offline and in CI, and lets the
 * store layer stay a thin adapter. Journal entries are graph-native meta statements (the
 * currents.ts pattern), so the history travels with TTL export/import and is visible to MCP tools.
 */

import type { Statement } from './types';
import { iri, lit } from './types';

export const ARCHIVE_META_PREFIX = 'urn:reckons:meta/archive/';
/** Journal events live under this prefix: urn:reckons:archive/event/<id> */
export const ARCHIVE_EVENT_PREFIX = 'urn:reckons:archive/event/';

export const ARC_TYPE = `${ARCHIVE_META_PREFIX}eventType`;
export const ARC_AT = `${ARCHIVE_META_PREFIX}at`;
export const ARC_ACTOR = `${ARCHIVE_META_PREFIX}actor`;
export const ARC_ENTITY = `${ARCHIVE_META_PREFIX}affectedEntity`;
export const ARC_COUNT = `${ARCHIVE_META_PREFIX}statementCount`;
export const ARC_PARENT = `${ARCHIVE_META_PREFIX}parentStableId`;
export const ARC_SNAPSHOT = `${ARCHIVE_META_PREFIX}hasSnapshot`;
export const ARC_MILESTONE = `${ARCHIVE_META_PREFIX}milestone`;
export const ARC_NOTE = `${ARCHIVE_META_PREFIX}note`;

/** The operations worth journalling. `revert` is here deliberately — see restoreIsReversible. */
export type ArchiveEventType = 'delete' | 'merge' | 'prune' | 'age-drop' | 'revert';

/**
 * Who caused this. Distinguishing human from agent is not bookkeeping: an agent that archived 200
 * nodes is a very different event from a human who did, and the user needs to be able to tell them
 * apart when deciding what to revert.
 */
export type ArchiveActor = 'human' | 'agent' | 'schedule';

export interface ArchiveEvent {
  id: string;
  type: ArchiveEventType;
  /** Epoch ms. Passed in, never read from the clock here, so tests are deterministic. */
  at: number;
  actor: ArchiveActor;
  /** Entity IRIs this operation touched. */
  entities: string[];
  /** How many statements moved out of the working graph. */
  statementCount: number;
  /** stableId of the graph this archive belongs to — the link back to the parent. */
  parentStableId?: string;
  /** Full pre-operation snapshot. Absent on events recorded without one. */
  snapshot?: Statement[];
  /** Milestone events survive retention pruning. */
  milestone?: boolean;
  /** Human-readable summary, shown in the archive UI. */
  note?: string;
}

/**
 * The archive graph's name, derived from its parent. Deliberately a pure string function: the
 * registry stores this as an ordinary graph name, so the "(archives)" suffix IS the convention.
 */
export function archiveGraphName(parentName: string): string {
  return `${parentName.trim()} (archives)`;
}

/** True when a graph name refers to an archive graph. */
export function isArchiveGraphName(name: string): boolean {
  return /\s\(archives\)$/.test(name.trim());
}

/** Recover the parent graph's name from an archive graph name. */
export function parentGraphName(archiveName: string): string {
  return archiveName.trim().replace(/\s\(archives\)$/, '');
}

// ── Journal serialization ────────────────────────────────────────────────────

const eventIri = (id: string) => `${ARCHIVE_EVENT_PREFIX}${id}`;

/**
 * Serialize an event to graph-native statements. Deterministic — stable ids derived from the
 * event, stable ordering — so write→read→write is identity and the TTL diffs cleanly in git.
 *
 * The snapshot's statements are NOT inlined here: they are returned separately by
 * `snapshotStatements` so the caller can persist them under the event's own provenance graph
 * without the journal entry itself becoming unreadable.
 */
export function eventToStatements(event: ArchiveEvent): Statement[] {
  const subj = eventIri(event.id);
  const g = iri('urn:kbase:graph/archive');
  const make = (p: string, v: string): Statement => ({
    id: `archive|${event.id}|${p}|${v}`,
    s: iri(subj),
    p: iri(p),
    o: lit(v),
    g,
    sourceId: 'archive-journal',
    confidence: 1,
    status: 'confirmed',
    createdAt: event.at,
    updatedAt: event.at,
  });

  const out: Statement[] = [
    make(ARC_TYPE, event.type),
    make(ARC_AT, String(event.at)),
    make(ARC_ACTOR, event.actor),
    make(ARC_COUNT, String(event.statementCount)),
  ];
  if (event.parentStableId) out.push(make(ARC_PARENT, event.parentStableId));
  if (event.milestone) out.push(make(ARC_MILESTONE, 'true'));
  if (event.note) out.push(make(ARC_NOTE, event.note));
  if (event.snapshot) out.push(make(ARC_SNAPSHOT, String(event.snapshot.length)));
  // Sorted so repeated writes of the same event produce byte-identical output.
  for (const e of [...new Set(event.entities)].sort()) {
    out.push({ ...make(ARC_ENTITY, e), o: iri(e) });
  }
  return out;
}

/**
 * Read events back out of a set of journal statements. Statements that are not journal entries are
 * ignored, so this is safe to run over a whole archive graph.
 *
 * Note the snapshot is NOT reconstructed here — only its recorded size. Snapshots are bulk data;
 * the caller loads them on demand by event id, because loading every snapshot to list the history
 * would defeat the point of keeping the working graph small.
 */
export function statementsToEvents(statements: Statement[]): ArchiveEvent[] {
  const byId = new Map<string, ArchiveEvent>();

  for (const st of statements) {
    if (st.s.kind !== 'iri' || !st.s.value.startsWith(ARCHIVE_EVENT_PREFIX)) continue;
    if (st.status === 'rejected' || st.status === 'superseded') continue;
    const id = st.s.value.slice(ARCHIVE_EVENT_PREFIX.length);
    let ev = byId.get(id);
    if (!ev) {
      ev = { id, type: 'delete', at: 0, actor: 'human', entities: [], statementCount: 0 };
      byId.set(id, ev);
    }
    const v = st.o.value;
    switch (st.p.value) {
      case ARC_TYPE: ev.type = v as ArchiveEventType; break;
      case ARC_AT: ev.at = Number(v) || 0; break;
      case ARC_ACTOR: ev.actor = v as ArchiveActor; break;
      case ARC_COUNT: ev.statementCount = Number(v) || 0; break;
      case ARC_PARENT: ev.parentStableId = v; break;
      case ARC_MILESTONE: ev.milestone = v === 'true'; break;
      case ARC_NOTE: ev.note = v; break;
      case ARC_ENTITY: if (!ev.entities.includes(v)) ev.entities.push(v); break;
    }
  }

  for (const ev of byId.values()) ev.entities.sort();
  // Newest first — the order the history is read in.
  return [...byId.values()].sort((a, b) => b.at - a.at);
}

// ── Retention ────────────────────────────────────────────────────────────────

export interface RetentionPolicy {
  /** Always keep this many most-recent snapshots. Default 10. */
  keepLast?: number;
  /**
   * Beyond the recent window, thin snapshots to at most one per period (ms). Default 1 day.
   * Keeps a browsable history without keeping every step of a busy afternoon.
   */
  thinToOnePer?: number;
  /** Never drop snapshots older than this many ms... nothing is kept forever by default. */
  maxAgeMs?: number;
}

export interface RetentionDecision {
  /** Events whose snapshots should be kept. */
  keep: ArchiveEvent[];
  /**
   * Events whose SNAPSHOTS should be dropped. The event itself is never deleted — losing the
   * record that something happened is a different and worse loss than losing the ability to
   * revert it, so retention only ever discards the bulky payload.
   */
  dropSnapshots: ArchiveEvent[];
}

/**
 * Decide which snapshots to keep. Milestones are always kept; the most recent `keepLast` are always
 * kept; beyond that, at most one snapshot survives per `thinToOnePer` window; anything older than
 * `maxAgeMs` loses its snapshot regardless.
 *
 * Returns a DECISION rather than mutating anything — the caller applies it. A retention pass that
 * deleted as it walked would be exactly the kind of silent destruction this feature exists to
 * prevent.
 */
export function applyRetention(events: ArchiveEvent[], policy: RetentionPolicy = {}, now = Date.now()): RetentionDecision {
  const { keepLast = 10, thinToOnePer = 24 * 60 * 60 * 1000, maxAgeMs } = policy;

  // Only events that actually carry a snapshot are candidates for thinning.
  const withSnapshots = events
    .filter((e) => e.snapshot !== undefined || e.statementCount > 0)
    .sort((a, b) => b.at - a.at);

  const keep: ArchiveEvent[] = [];
  const dropSnapshots: ArchiveEvent[] = [];
  let lastKeptBucket: number | null = null;

  withSnapshots.forEach((ev, index) => {
    const tooOld = maxAgeMs !== undefined && now - ev.at > maxAgeMs;

    // Milestones outrank everything except an explicit max-age cutoff.
    if (ev.milestone && !tooOld) { keep.push(ev); return; }
    if (tooOld) { dropSnapshots.push(ev); return; }
    if (index < keepLast) { keep.push(ev); return; }

    const bucket = Math.floor(ev.at / Math.max(thinToOnePer, 1));
    if (lastKeptBucket === null || bucket !== lastKeptBucket) {
      lastKeptBucket = bucket;
      keep.push(ev);
    } else {
      dropSnapshots.push(ev);
    }
  });

  return { keep, dropSnapshots };
}

/**
 * Estimated storage a set of snapshots costs, in statements. Crude on purpose — it exists so the
 * UI can tell the user "your archive is holding 40k statements of history" BEFORE that becomes a
 * surprise, which is the honest way to ship a feature whose cost grows quietly.
 */
export function snapshotFootprint(events: ArchiveEvent[]): number {
  return events.reduce((n, e) => n + (e.snapshot?.length ?? e.statementCount), 0);
}

// ── The move itself ──────────────────────────────────────────────────────────

export interface ArchiveMoveInput {
  statements: Statement[];
  /** Entity IRIs to move out of the working graph. */
  entities: string[];
  type: ArchiveEventType;
  actor: ArchiveActor;
  at: number;
  eventId: string;
  parentStableId?: string;
  milestone?: boolean;
  note?: string;
}

export interface ArchiveMoveResult {
  /** What stays in the working graph. */
  kept: Statement[];
  /** What moves to the archive graph. */
  archived: Statement[];
  /** The journal entry, carrying the full pre-operation snapshot. */
  event: ArchiveEvent;
}

/**
 * Move every statement touching the given entities out of the working graph.
 *
 * A statement is archived if the entity appears as its SUBJECT or its OBJECT. Archiving only by
 * subject would leave dangling edges pointing at nodes that no longer exist — a graph that renders
 * arrows into empty space, which is worse than either keeping or removing the node cleanly.
 *
 * Pure: returns the two halves plus the journal entry, and mutates nothing. The caller writes
 * `kept` back to the working graph and `archived` + `event` to the archive graph, so a failure
 * between the two is a caller-visible transaction problem rather than a silent half-move here.
 */
export function archiveEntities(input: ArchiveMoveInput): ArchiveMoveResult {
  const targets = new Set(input.entities);
  const kept: Statement[] = [];
  const archived: Statement[] = [];

  for (const st of input.statements) {
    const touches =
      (st.s.kind === 'iri' && targets.has(st.s.value)) ||
      (st.o.kind === 'iri' && targets.has(st.o.value));
    (touches ? archived : kept).push(st);
  }

  return {
    kept,
    archived,
    event: {
      id: input.eventId,
      type: input.type,
      at: input.at,
      actor: input.actor,
      entities: [...targets].sort(),
      statementCount: archived.length,
      parentStableId: input.parentStableId,
      // The snapshot is the PRE-operation graph — that is what revert needs.
      snapshot: input.statements,
      milestone: input.milestone,
      note: input.note,
    },
  };
}

/**
 * Restore a snapshot: the working graph becomes exactly what it was before the operation.
 *
 * Returns the statements to write plus the journal entry for the revert ITSELF — reverting is a
 * destructive operation like any other, and an undo that cannot be undone is a trap. The revert
 * event carries the pre-revert state as its own snapshot, so redo is just another restore.
 */
export class SnapshotRestoreError extends Error {}

export function restoreSnapshot(
  currentStatements: Statement[],
  snapshot: Statement[],
  meta: {
    eventId: string; at: number; actor: ArchiveActor; parentStableId?: string; note?: string;
    /** Required to restore an EMPTY snapshot over a non-empty graph. See below. */
    force?: boolean;
  },
): { restored: Statement[]; event: ArchiveEvent } {
  // GUARD (raised by the local code-review agent, 2026-07-18): restoring blindly makes this
  // function a graph-wiper. An empty snapshot over a non-empty graph is the dangerous case — it
  // is indistinguishable from "restore a snapshot that failed to load", and silently erasing a
  // populated graph is precisely the silent-destruction failure this feature exists to prevent.
  //
  // An empty snapshot IS legitimate when the graph really was empty before the operation, so this
  // is not a hard ban: it demands an explicit `force`, which makes the destructive read deliberate
  // rather than accidental.
  if (snapshot.length === 0 && currentStatements.length > 0 && !meta.force) {
    throw new SnapshotRestoreError(
      `Refusing to restore an empty snapshot over a graph holding ${currentStatements.length} statement(s). ` +
      `If the graph really was empty before this operation, pass force: true.`,
    );
  }
  const restoredEntities = new Set<string>();
  for (const st of snapshot) if (st.s.kind === 'iri') restoredEntities.add(st.s.value);

  return {
    restored: snapshot,
    event: {
      id: meta.eventId,
      type: 'revert',
      at: meta.at,
      actor: meta.actor,
      entities: [...restoredEntities].sort(),
      statementCount: snapshot.length,
      parentStableId: meta.parentStableId,
      snapshot: currentStatements, // pre-revert state, so the revert is itself revertible
      note: meta.note ?? `Reverted to a snapshot of ${snapshot.length} statements`,
    },
  };
}

// ── F97.3 Restore-on-reference ───────────────────────────────────────────────

export interface ArchivedReference {
  /** The archived entity an incoming statement appears to be about. */
  entity: string;
  /** The archived entity's label, for the restore prompt. */
  label: string;
  /** Incoming statements that referenced it. */
  incoming: Statement[];
}

const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const normLabel = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Find incoming statements that refer to something already sitting in the archive.
 *
 * WHY THIS IS A REQUIREMENT, not a nicety: once entities leave the working graph, the next ingest
 * that mentions one will happily mint a fresh duplicate node. Archiving without this makes the
 * duplicate problem WORSE with every sweep — it would manufacture exactly the mess the merge
 * analysis exists to clean up. Matching is by IRI first, then by normalized label, mirroring the
 * conservative exact-match rule used elsewhere; fuzzy matching is the merge analysis's job, not
 * this function's.
 */
export function findArchivedReferences(
  incoming: Statement[],
  archivedStatements: Statement[],
): ArchivedReference[] {
  const archivedLabels = new Map<string, string>();   // entity IRI → label
  const byNormLabel = new Map<string, string>();      // normalized label → entity IRI
  const archivedIris = new Set<string>();

  for (const st of archivedStatements) {
    if (st.s.kind !== 'iri') continue;
    archivedIris.add(st.s.value);
    if (st.p.value === RDFS_LABEL) {
      archivedLabels.set(st.s.value, st.o.value);
      byNormLabel.set(normLabel(st.o.value), st.s.value);
    }
  }

  const hits = new Map<string, Statement[]>();
  const hit = (entity: string, st: Statement) => {
    if (!hits.has(entity)) hits.set(entity, []);
    hits.get(entity)!.push(st);
  };

  for (const st of incoming) {
    // Direct IRI reference to an archived entity.
    if (st.s.kind === 'iri' && archivedIris.has(st.s.value)) { hit(st.s.value, st); continue; }
    if (st.o.kind === 'iri' && archivedIris.has(st.o.value)) { hit(st.o.value, st); continue; }
    // A new node carrying the same label as an archived one.
    if (st.p.value === RDFS_LABEL) {
      const match = byNormLabel.get(normLabel(st.o.value));
      if (match && !(st.s.kind === 'iri' && st.s.value === match)) hit(match, st);
    }
  }

  return [...hits.entries()]
    .map(([entity, incomingStatements]) => ({
      entity,
      label: archivedLabels.get(entity) ?? entity,
      incoming: incomingStatements,
    }))
    .sort((a, b) => b.incoming.length - a.incoming.length);
}

// ── F97.6 Churn insight ──────────────────────────────────────────────────────

export interface ChurnScore {
  entity: string;
  /** How many separate archive events touched this entity. */
  archivedCount: number;
  /** Timestamp of the most recent archiving. */
  lastArchivedAt: number;
  /** True once the entity has cycled often enough to indicate a noisy source. */
  churning: boolean;
}

/**
 * Find entities that keep getting archived.
 *
 * High churn is a signal about the PIPELINE, not about the user: an entity that is repeatedly
 * extracted, archived, re-extracted and archived again usually means a noisy source or a sloppy
 * extraction prompt. Surfacing it turns the archive from a graveyard into a diagnostic — and the
 * finding routes into the analysis advisor rather than being reported as a user failing.
 */
export function detectChurn(events: ArchiveEvent[], threshold = 3): ChurnScore[] {
  const counts = new Map<string, { n: number; last: number }>();
  for (const ev of events) {
    if (ev.type === 'revert') continue; // a revert is not evidence of churn, it is the cure
    for (const e of ev.entities) {
      const cur = counts.get(e) ?? { n: 0, last: 0 };
      counts.set(e, { n: cur.n + 1, last: Math.max(cur.last, ev.at) });
    }
  }
  return [...counts.entries()]
    .map(([entity, { n, last }]) => ({
      entity, archivedCount: n, lastArchivedAt: last, churning: n >= threshold,
    }))
    .sort((a, b) => b.archivedCount - a.archivedCount);
}
