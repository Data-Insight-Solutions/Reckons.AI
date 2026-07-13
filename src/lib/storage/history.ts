/**
 * History Mode reconstruction (kb:history-mode).
 *
 * Extracted from routes/(app)/history/+page.svelte so it can be TESTED. The feature was
 * marked `production` with no test, and it had two defects that a single test would have
 * caught — both of which made the graph LIE about the past, which is the one thing a
 * history feature exists not to do.
 *
 * BUG 1 (fixed here): DELETED FACTS COULD NEVER COME BACK.
 * The page rebuilt the past by filtering the CURRENT statement set. Deletion is a hard
 * `db.statements.delete(id)`, so a fact deleted since T is not in that set — it could not
 * be filtered *in*. History Mode could only ever hide recent additions; scrubbing back to
 * a time when a fact existed showed you a graph without it. The "was it deleted before T?"
 * branch was unreachable dead code. We now rebuild from the CHANGELOG, using the tombstone
 * (`before`, an {s,p,o} snapshot written at delete time) to resurrect the fact as it was.
 *
 * BUG 2 (fixed here): the page carried its own COPY of the trust maths — the pre-fix copy,
 * with the baseline dropped (`score = Σ deltas`). That is the identical bug fixed in
 * trust.ts on 2026-07-12; the fix never reached here because the logic was duplicated
 * rather than imported. Every source in History Mode scored near zero. We now call
 * `computeTrustScore`, so there is exactly one implementation of trust in the codebase.
 *
 * THE HONEST GAP (not a bug — a declared limit): a statement with no `add`/`ingest` entry
 * in the changelog cannot be dated. That is real: graphs imported before the changelog
 * existed, or seeded from TTL, have no arrival record. We refuse to guess in either
 * direction — asserting it was there is an unverifiable claim, and asserting it was not is
 * equally unfounded. Undated statements are returned SEPARATELY so the UI can say how many
 * facts it cannot place in time, rather than silently dropping them (which is what the old
 * code did) or silently including them.
 */
import type { Statement, Source } from '$lib/rdf/types';
import type { ChangeLogEntry, TrustEvent } from './types';
import { computeTrustScore } from './trust';

/** Changelog actions that bring a statement into existence. */
const ADD_ACTIONS = new Set<ChangeLogEntry['action']>(['add', 'ingest']);

export interface HistoryReconstruction {
  /** Facts that demonstrably existed at the requested time. */
  statements: Statement[];
  /**
   * Facts we cannot place in time — no `add`/`ingest` entry in the changelog. Shown to the
   * user as a count, never quietly folded into (or out of) the reconstruction.
   */
  undated: Statement[];
}

/**
 * Rebuild the {s,p,o} of a deleted statement from its tombstone.
 *
 * `addedAt` is the fact's real arrival time, taken from the changelog, so a revived fact
 * carries honest timestamps rather than invented ones.
 *
 * Returns null when the tombstone is missing or unparseable — an unreadable tombstone is a
 * fact we cannot honestly render, so it is dropped rather than shown as a half-statement.
 */
function fromTombstone(entry: ChangeLogEntry, addedAt: number): Statement | null {
  if (!entry.statementId || !entry.before) return null;

  let parsed: Partial<Pick<Statement, 's' | 'p' | 'o'>>;
  try {
    parsed = JSON.parse(entry.before);
  } catch {
    return null;
  }
  if (!parsed?.s || !parsed?.p || !parsed?.o) return null;

  const sourceId = entry.sourceId ?? '';
  return {
    id: entry.statementId,
    s: parsed.s,
    p: parsed.p,
    o: parsed.o,
    g: { kind: 'iri', value: `urn:kbase:source/${sourceId}` },
    sourceId,
    confidence: 1,
    // It existed and was later deleted; at time T it was simply a fact in the graph.
    status: 'confirmed',
    createdAt: addedAt,
    updatedAt: entry.timestamp,
  };
}

/**
 * The set of statements that existed at `timestamp`.
 *
 * Pure: the caller supplies the current statements and the full changelog. Statements are
 * matched by id, and existence is decided by REPLAYING the changelog in time order, so an
 * add → delete → re-add history resolves correctly (the old code took the `.first()`
 * matching entry, which is index order, not time order — it got this wrong).
 *
 * A `timestamp` of null means "now": the live set, unfiltered.
 */
export function reconstructStatementsAt(
  current: Statement[],
  changelog: ChangeLogEntry[],
  timestamp: number | null,
): HistoryReconstruction {
  if (timestamp === null) return { statements: [...current], undated: [] };

  const currentById = new Map(current.map((st) => [st.id, st]));

  // Replay the changelog in time order, per statement.
  const byStatement = new Map<string, ChangeLogEntry[]>();
  for (const entry of changelog) {
    if (!entry.statementId) continue;
    const list = byStatement.get(entry.statementId);
    if (list) list.push(entry);
    else byStatement.set(entry.statementId, [entry]);
  }

  const statements: Statement[] = [];

  for (const [statementId, entries] of byStatement) {
    const ordered = [...entries].sort((a, b) => a.timestamp - b.timestamp);

    let exists = false;
    let lastTombstone: ChangeLogEntry | null = null;
    let addedAt = 0; // when the fact arrived in the life it is living at `timestamp`

    for (const entry of ordered) {
      if (entry.timestamp > timestamp) break; // The future is not evidence.
      if (ADD_ACTIONS.has(entry.action)) {
        if (!exists) addedAt = entry.timestamp;
        exists = true;
      } else if (entry.action === 'delete') {
        exists = false;
        lastTombstone = entry;
      }
    }

    if (!exists) continue;

    // Still in the graph today → use the live row (it carries excerpt, status, confidence).
    const live = currentById.get(statementId);
    if (live) {
      statements.push(live);
      continue;
    }

    // Deleted since T → resurrect it from the tombstone written when it was deleted.
    // Without this, everything you have ever deleted is invisible at every past time.
    const deletedLater = [...entries]
      .sort((a, b) => b.timestamp - a.timestamp)
      .find((e) => e.action === 'delete' && e.timestamp > timestamp);
    const tombstone = deletedLater ?? lastTombstone;
    const revived = tombstone ? fromTombstone(tombstone, addedAt) : null;
    if (revived) statements.push(revived);
  }

  // Statements with no arrival record: we cannot date them, and we will not pretend to.
  const undated = current.filter((st) => {
    const entries = byStatement.get(st.id);
    return !entries?.some((e) => ADD_ACTIONS.has(e.action));
  });

  return { statements, undated };
}

/**
 * Sources with their trust score as it stood at `timestamp`.
 *
 * Uses the same scorer as the live app (`computeTrustScore`) — baseline plus time-decayed
 * judgements — evaluated with `now = timestamp` so decay is measured from the past instant
 * being viewed, not from today.
 */
export function reconstructSourcesAt(
  sources: Source[],
  trustEvents: Pick<TrustEvent, 'sourceId' | 'delta' | 'timestamp'>[],
  timestamp: number | null,
): Source[] {
  if (timestamp === null) return [...sources];

  const eventsBySource = new Map<string, Pick<TrustEvent, 'delta' | 'timestamp'>[]>();
  for (const ev of trustEvents) {
    if (ev.timestamp > timestamp) continue; // A judgement not yet made is not evidence.
    const list = eventsBySource.get(ev.sourceId);
    if (list) list.push(ev);
    else eventsBySource.set(ev.sourceId, [ev]);
  }

  return sources.map((src) => ({
    ...src,
    trustScore: computeTrustScore(eventsBySource.get(src.id) ?? [], src.trustLevel, timestamp),
  }));
}
