import { db } from '../storage/db';
import type { Statement, Source, ReviewStatus } from '../rdf/types';
import type { ChangeLogEntry, TrustEvent } from '../storage/types';
import { scheduleAutoSave } from '../storage/backup';
import { scheduleWorkspaceTtlExport } from './workspace.svelte';
import { officialKbActive, officialKbStatements, officialKbSources } from './official-kb.svelte';
import { filterBlockedStatements } from '../safety/content-policy';

/**
 * Module-level reactive state using Svelte 5 runes ($state).
 * Components import the getters; mutating functions update the store and
 * persist to IndexedDB in the same tick.
 */

let _sources = $state<Source[]>([]);
let _statements = $state<Statement[]>([]);
let _loaded = $state(false);

/**
 * Log a change to the changelog table.
 * @internal
 */
async function logChange(entry: Omit<ChangeLogEntry, 'timestamp' | 'id'>) {
  const row = { ...entry, timestamp: Date.now() } as ChangeLogEntry;
  await db.changelog.add(row);
}

/**
 * Record a trust event (affects source trustScore).
 * @internal
 */
async function logTrustEvent(event: Omit<TrustEvent, 'timestamp' | 'id'>) {
  const row = { ...event, timestamp: Date.now() } as TrustEvent;
  await db.trustEvents.add(row);
}

/**
 * Calculate the current trust score for a source based on time-decayed TrustEvents.
 * Formula: score = Σ(delta * e^(-0.01 * age_days)) normalized to 0–1
 */
export async function getTrustScore(sourceId: string): Promise<number> {
  const events = await db.trustEvents.where('sourceId').equals(sourceId).toArray();
  if (events.length === 0) {
    // Default based on trustLevel if available
    const src = _sources.find(s => s.id === sourceId);
    return src?.trustLevel === 'trusted' ? 0.8 : 0.3;
  }

  const now = Date.now();
  let score = 0;
  for (const ev of events) {
    const ageDays = (now - ev.timestamp) / (1000 * 60 * 60 * 24);
    const decayFactor = Math.exp(-0.01 * ageDays);
    score += ev.delta * decayFactor;
  }
  // Clamp to [0, 1]
  return Math.max(0, Math.min(1, score));
}

export function sources(): Source[] {
  return officialKbActive() ? officialKbSources() : _sources;
}
export function statements(): Statement[] {
  return officialKbActive() ? officialKbStatements() : _statements;
}
/** The user's own statements (ignores official KB overlay) */
export function userStatements(): Statement[] {
  return _statements;
}
export function loaded(): boolean {
  return _loaded;
}

export async function loadAll() {
  const [srcs, sts] = await Promise.all([
    db.sources.orderBy('ingestedAt').reverse().toArray(),
    db.statements.toArray()
  ]);
  _sources = srcs;
  _statements = sts;
  _loaded = true;
}

/** Returns true if the official KB is active (mutations should be blocked). */
function isReadOnly(): boolean {
  return officialKbActive();
}

const _afterAddSourceHooks: Array<(src: Source) => void> = [];

/** Register a callback that fires after any source is added. */
export function onAfterAddSource(cb: (src: Source) => void) {
  _afterAddSourceHooks.push(cb);
}

export async function addSource(src: Source) {
  if (isReadOnly()) return;
  await db.sources.put(src);
  _sources = [src, ..._sources];
  for (const hook of _afterAddSourceHooks) hook(src);
}

export async function deleteSource(id: string) {
  if (isReadOnly()) return;
  await db.transaction('rw', db.sources, db.statements, async () => {
    await db.sources.delete(id);
    await db.statements.where('sourceId').equals(id).delete();
  });
  _sources = _sources.filter((s) => s.id !== id);
  _statements = _statements.filter((s) => s.sourceId !== id);
}

export async function setSourceTrust(id: string, trustLevel: 'trusted' | 'review') {
  if (isReadOnly()) return;
  const cur = _sources.find((s) => s.id === id);
  if (!cur) return;
  const before = JSON.stringify({ trustLevel: cur.trustLevel });
  const updated = { ...cur, trustLevel };
  await db.sources.put(updated);
  _sources = _sources.map((s) => (s.id === id ? updated : s));

  // Log the change for audit trail
  await logChange({
    action: 'trust_update',
    sourceId: id,
    before,
    after: JSON.stringify({ trustLevel })
  });
}

export async function autoConfirmTrustedSources() {
  if (isReadOnly()) return;
  const trustedSourceIds = _sources
    .filter((s) => s.trustLevel === 'trusted')
    .map((s) => s.id);

  if (trustedSourceIds.length === 0) return;

  const statementsToConfirm = _statements.filter(
    (s) => trustedSourceIds.includes(s.sourceId) && s.status === 'pending'
  );

  await db.transaction('rw', db.statements, async () => {
    for (const st of statementsToConfirm) {
      const confirmed = JSON.parse(
        JSON.stringify({ ...st, status: 'confirmed', updatedAt: Date.now() })
      ) as Statement;
      await db.statements.put(confirmed);
    }
  });

  _statements = _statements.map((s) =>
    trustedSourceIds.includes(s.sourceId) && s.status === 'pending'
      ? JSON.parse(JSON.stringify({ ...s, status: 'confirmed', updatedAt: Date.now() })) as Statement
      : s
  );

  // Log auto-confirmations
  for (const st of statementsToConfirm) {
    await logChange({
      action: 'confirm',
      statementId: st.id,
      sourceId: st.sourceId,
      note: 'auto-confirmed from trusted source',
      before: JSON.stringify({ status: st.status }),
      after: JSON.stringify({ status: 'confirmed' })
    });
  }
}

export async function addStatements(sts: Statement[], sourceId?: string) {
  if (isReadOnly() || sts.length === 0) return;

  // Content safety gate — block extreme content before save
  const { allowed, blocked, blockReasons } = filterBlockedStatements(sts);
  if (blocked.length > 0) {
    console.warn(`[ContentPolicy] Blocked ${blocked.length} statement(s):`,
      blocked.map(s => ({ id: s.id, reasons: blockReasons[s.id] })));
    for (const st of blocked) {
      await logChange({
        action: 'reject',
        statementId: st.id,
        sourceId: st.sourceId,
        note: `content-policy: ${blockReasons[st.id]?.join(', ') ?? 'blocked'}`,
        after: JSON.stringify({ s: st.s, p: st.p, o: st.o, status: 'rejected' })
      });
    }
  }
  if (allowed.length === 0) return;

  // Clean statements via JSON round-trip to ensure IndexedDB compatibility
  const cleanedSts = allowed.map(st => JSON.parse(JSON.stringify(st)) as Statement);
  await db.statements.bulkPut(cleanedSts);
  _statements = [..._statements, ...cleanedSts];

  // Log ingest/add action for each statement
  for (const st of cleanedSts) {
    await logChange({
      action: sourceId ? 'ingest' : 'add',
      statementId: st.id,
      sourceId: st.sourceId,
      after: JSON.stringify({ s: st.s, p: st.p, o: st.o, status: st.status })
    });
  }
  scheduleAutoSave();
  scheduleWorkspaceTtlExport();
}

export async function updateStatement(id: string, patch: Partial<Statement>) {
  if (isReadOnly()) return;
  const cur = _statements.find((s) => s.id === id);
  if (!cur) return;
  // Merge and ensure clean object by JSON round-trip
  const merged = { ...cur, ...patch, updatedAt: Date.now() };
  const next = JSON.parse(JSON.stringify(merged)) as Statement;
  await db.statements.put(next);
  _statements = _statements.map((s) => (s.id === id ? next : s));
}

export async function setStatus(id: string, status: ReviewStatus) {
  if (isReadOnly()) return;
  const cur = _statements.find((s) => s.id === id);
  if (!cur) return;

  await updateStatement(id, { status });

  // Log the status change
  const logAction = status === 'confirmed' || status === 'refined' ? 'confirm'
    : status === 'rejected' ? 'reject'
    : 'confirm'; // pending-removal and others treated as non-destructive
  await logChange({
    action: logAction,
    statementId: id,
    sourceId: cur.sourceId,
    before: JSON.stringify({ status: cur.status }),
    after: JSON.stringify({ status })
  });

  // Emit trust event for user confirmations/rejections
  if ((status === 'confirmed' || status === 'refined') && cur.status === 'pending') {
    await logTrustEvent({
      sourceId: cur.sourceId,
      delta: 0.05,
      reason: 'confirm',
      statementId: id
    });
  } else if (status === 'rejected' && cur.status === 'pending') {
    await logTrustEvent({
      sourceId: cur.sourceId,
      delta: -0.1,
      reason: 'reject',
      statementId: id
    });
  }
  scheduleAutoSave();
  scheduleWorkspaceTtlExport();
}

export async function supersede(oldId: string, newSt: Statement) {
  if (isReadOnly()) return;
  const oldSt = _statements.find(s => s.id === oldId);

  await db.transaction('rw', db.statements, async () => {
    const old = await db.statements.get(oldId);
    if (old) {
      const updated = JSON.parse(JSON.stringify({ ...old, status: 'superseded', updatedAt: Date.now() })) as Statement;
      await db.statements.put(updated);
    }
    const cleanNewSt = JSON.parse(JSON.stringify({ ...newSt, supersedes: oldId })) as Statement;
    await db.statements.put(cleanNewSt);
  });

  _statements = _statements.map((s) =>
    s.id === oldId ? JSON.parse(JSON.stringify({ ...s, status: 'superseded', updatedAt: Date.now() })) as Statement : s
  );
  _statements = [..._statements, JSON.parse(JSON.stringify({ ...newSt, supersedes: oldId })) as Statement];

  // Log the supersession
  await logChange({
    action: 'supersede',
    statementId: oldId,
    sourceId: oldSt?.sourceId,
    before: JSON.stringify({ s: oldSt?.s, p: oldSt?.p, o: oldSt?.o }),
    after: JSON.stringify({ s: newSt.s, p: newSt.p, o: newSt.o })
  });
  scheduleAutoSave();
  scheduleWorkspaceTtlExport();
}

export async function deleteStatement(id: string) {
  if (isReadOnly()) return;
  const st = _statements.find(s => s.id === id);
  await db.statements.delete(id);
  _statements = _statements.filter((s) => s.id !== id);

  // Log the deletion
  await logChange({
    action: 'delete',
    statementId: id,
    sourceId: st?.sourceId,
    before: JSON.stringify({ s: st?.s, p: st?.p, o: st?.o })
  });
  scheduleAutoSave();
  scheduleWorkspaceTtlExport();
}

/** Statements awaiting add-confirmation (excludes meta/operation statements). */
export function pendingStatements(): Statement[] {
  return _statements.filter(
    (s) => s.status === 'pending' && s.p.value !== 'urn:kbase:meta/suggests-merge'
  );
}

/** Statements suggested for deletion, awaiting confirmation to reject. */
export function pendingRemovalStatements(): Statement[] {
  return _statements.filter((s) => s.status === 'pending-removal');
}

/** Pending merge-operation statements (special meta-predicate). */
export function pendingMergeStatements(): Statement[] {
  return _statements.filter(
    (s) => s.status === 'pending' && s.p.value === 'urn:kbase:meta/suggests-merge'
  );
}

export function confirmedStatements(): Statement[] {
  return statements().filter((s) => s.status === 'confirmed' || s.status === 'refined');
}

export function statementsForSource(sourceId: string): Statement[] {
  return statements().filter((s) => s.sourceId === sourceId);
}
