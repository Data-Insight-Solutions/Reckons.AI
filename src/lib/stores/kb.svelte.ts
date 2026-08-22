import { db } from '../storage/db';
import type { ExtractionRun, Statement, Source, ReviewStatus } from '../rdf/types';
import { isIRI, termKey } from '../rdf/types';
import { labelFromIRI } from '../rdf/semantic-diff';
import { gateFactWrite } from '../rdf/agent-edit-boundary';
import type { ChangeLogEntry, TrustEvent } from '../storage/types';
import { computeTrustScore } from '../storage/trust';
import { scheduleAutoSave } from '../storage/backup';
import { scheduleWorkspaceTtlExport } from './workspace.svelte';
import { scheduleDrivePush } from './drive-sync.svelte';
import { officialKbActive, officialKbStatements, officialKbSources, deactivateOfficialKb } from './official-kb.svelte';
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
 * Current trust score for a source: its baseline, moved by time-decayed user
 * judgements. The maths lives in storage/trust.ts so it can be tested — see the bug
 * documented there (the old version discarded the baseline the moment any event
 * existed, so CONFIRMING a fact made its source less trusted).
 */
export async function getTrustScore(sourceId: string): Promise<number> {
  const events = await db.trustEvents.where('sourceId').equals(sourceId).toArray();
  const src = _sources.find((s) => s.id === sourceId);
  return computeTrustScore(events, src?.trustLevel);
}

export function sources(): Source[] {
  return officialKbActive() ? officialKbSources() : _sources;
}
export function statements(): Statement[] {
  return officialKbActive() ? officialKbStatements() : _statements;
}
/**
 * Existing entities (subject + object IRIs from live statements) as
 * {key,label,iri} for search-while-typing pickers, e.g. filling a partial
 * fact's object (F32). Excludes pending/rejected; label falls back to the
 * IRI's local name.
 */
export function entityChoices(): { key: string; label: string; iri: string }[] {
  const map = new Map<string, { key: string; label: string; iri: string }>();
  for (const st of statements()) {
    if (st.status === 'pending' || st.status === 'rejected' || st.status === 'superseded') continue;
    for (const term of [st.s, st.o]) {
      if (!isIRI(term)) continue;
      const k = termKey(term);
      if (map.has(k)) continue;
      map.set(k, { key: k, label: labelFromIRI(term.value), iri: term.value });
    }
  }
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
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

/**
 * Hot-swap store data for seamless KB transitions (leap animation).
 * Replaces statements and sources without a page reload. The `db` singleton
 * still points to the previous DB — call switchToKb() for a full transition
 * when the user navigates away or the session can tolerate a reload.
 */
export function hotSwapData(stmts: Statement[], srcs: Source[]) {
  // A hot-swap means we've navigated to a real registered KB (e.g. a KB leap
  // from the read-only docs hub). The official-KB overlay must be dropped first
  // — otherwise statements()/sources() keep returning officialKbStatements() and
  // mask the swapped-in data, so the leap silently appears to do nothing.
  if (officialKbActive()) deactivateOfficialKb();
  _statements = stmts;
  _sources = srcs;
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

export type StatementWriteOptions = { origin?: 'manual' | 'current' | 'agent' };

/** The shared write funnel's decision, made before a caller opens its persistence transaction. */
export type PreparedStatementWrite = {
  statements: Statement[];
  blocked: Array<{ statement: Statement; reasons: string[] }>;
  opts?: StatementWriteOptions;
};

/**
 * Apply every existing statement-admission rule without writing a statement row.
 *
 * The separation is intentional: ordinary callers still use addStatements(), while ingest can
 * decide the exact accepted batch, attach those ids to its run, and atomically write source,
 * statement rows, changelog rows and terminal ExtractionRun. Archive prompts remain deliberately
 * outside a transaction because they await a later human decision.
 */
export async function prepareStatementsForWrite(
  sts: Statement[],
  sourceId?: string,
  opts?: StatementWriteOptions,
): Promise<PreparedStatementWrite> {
  if (isReadOnly() || sts.length === 0) return { statements: [], blocked: [], opts };

  // Currents type gate (F29) — only batches originating from a current are
  // gated, and only NEW entity creation is blocked; facts on entities already
  // in the graph always pass (still pending review).
  if (opts?.origin === 'current') {
    const { readCurrentsSettings, applyTypeGate } = await import('$lib/rdf/currents');
    const settings = readCurrentsSettings(_statements);
    const existing = new Set<string>();
    for (const st of _statements) {
      if (st.status !== 'rejected' && st.status !== 'superseded') existing.add(st.s.value);
    }
    const gate = applyTypeGate(sts, existing, settings);
    if (gate.gatedStatementCount > 0) {
      console.info(
        `[Currents] Type gate dropped ${gate.gatedStatementCount} statement(s) for ` +
        `${Object.keys(gate.gatedEntities).length} disallowed new entit(y/ies):`,
        gate.gatedEntities
      );
    }
    sts = gate.allowed;
    if (sts.length === 0) return { statements: [], blocked: [], opts };
  }

  // Content safety gate — block extreme content before save
  const { allowed, blocked, blockReasons } = filterBlockedStatements(sts);
  if (blocked.length > 0) {
    console.warn(`[ContentPolicy] Blocked ${blocked.length} statement(s):`,
      blocked.map(s => ({ id: s.id, reasons: blockReasons[s.id] })));
  }
  const held = blocked.map((statement) => ({
    statement,
    reasons: blockReasons[statement.id] ?? ['blocked'],
  }));
  if (allowed.length === 0) return { statements: [], blocked: held, opts };

  // F52 agent-edit boundary (kb:control-model): the human holds the fact-edit right; an agent may
  // only PROPOSE. When this batch is agent-originated, run every status through the boundary so a
  // settled write (confirmed/refined) is downgraded to a proposal. Today the agent paths already
  // write 'pending', so this is a no-op in practice — but it moves the rule from CONVENTION to an
  // enforced WALL in the code path: a future change that tried to land an agent-settled fact
  // would be caught here, not trusted to remember the convention.
  let gated = allowed;
  if (opts?.origin === 'agent') {
    let coercedCount = 0;
    gated = allowed.map((st) => {
      const decision = gateFactWrite('agent', st.status);
      if (decision.coerced) coercedCount++;
      return decision.coerced ? { ...st, status: decision.status } : st;
    });
    if (coercedCount > 0) {
      console.warn(`[F52] agent-edit boundary: downgraded ${coercedCount} settled write(s) to pending — agents propose, they do not settle.`);
    }
  }

  // F97.3 ARCHIVE RESTORE GUARD — do not silently duplicate what is merely archived.
  //
  // The detector (archive-store.findArchivedReferencesForParent) and the restore action
  // (restoreArchivedEntityForParent) both existed and were unreachable, because nothing called
  // the detector at a commit boundary. This is that call. addStatements is the single funnel
  // for every write — 32 call sites reach it — so one hook covers every ingest path rather
  // than each path remembering to check.
  //
  // Only the MATCHING statements are held: a 200-fact import that mentions one archived entity
  // writes 199 and pauses one. Holding the batch would punish the user for having archived
  // anything. And it PAUSES rather than auto-restoring, because the match is a conservative
  // label/IRI heuristic, not proof of identity — auto-restoring on a label collision would
  // resurrect something deliberately archived. Agents propose, humans settle (F52).
  //
  // Best-effort: any failure here writes the batch unchanged. A guard that could block an
  // ingest when the archive is unreadable would be worse than the duplicate it prevents.
  try {
    const { getCurrentKbId, getRegistry } = await import('$lib/storage/kb-registry');
    const parentStableId = getRegistry().find((e) => e.id === getCurrentKbId())?.stableId;
    if (parentStableId) {
      const [{ findArchivedReferencesForParent }, { guardIncoming, describePrompt }] = await Promise.all([
        import('$lib/storage/archive-store'),
        import('$lib/rdf/archive-guard'),
      ]);
      const matches = await findArchivedReferencesForParent(parentStableId, gated);
      const decision = guardIncoming(gated, matches);
      if (decision.prompts.length > 0) {
        const { pushNotification } = await import('./notifications.svelte');
        for (const prompt of decision.prompts) {
          pushNotification({
            id: `archive-restore-${prompt.entity}`,
            type: 'warn',
            title: 'Archived entity mentioned',
            body: describePrompt(prompt),
            action: {
              label: 'restore it',
              onclick: () => {
                void (async () => {
                  const { restoreArchivedEntityForParent } = await import('$lib/storage/archive-store');
                  await restoreArchivedEntityForParent({
                    workingKbId: getCurrentKbId(),
                    parentStableId,
                    entity: prompt.entity,
                    actor: 'human',
                  });
                  await addStatements(prompt.statements, sourceId, opts);
                  await loadAll();
                })();
              },
            },
            // Dismissing is the "keep separate" branch: the held facts are written as they
            // arrived, minting the new node. Silence must not DISCARD the user's ingest.
            ondismiss: () => { void addStatements(prompt.statements, sourceId, opts); },
          });
        }
        gated = decision.write;
        if (gated.length === 0) return { statements: [], blocked: held, opts };
      }
    }
  } catch (e) {
    console.warn('[F97.3] archive guard skipped:', e);
  }

  return {
    // Clean statements via JSON round-trip to ensure IndexedDB compatibility.
    statements: gated.map(st => JSON.parse(JSON.stringify(st)) as Statement),
    blocked: held,
    opts,
  };
}

function changeLogRow(entry: Omit<ChangeLogEntry, 'timestamp' | 'id'>): ChangeLogEntry {
  return { ...entry, timestamp: Date.now() } as ChangeLogEntry;
}

async function writeStatementChangeLog(plan: PreparedStatementWrite, sourceId?: string) {
  for (const { statement, reasons } of plan.blocked) {
    await db.changelog.add(changeLogRow({
      action: 'reject',
      statementId: statement.id,
      sourceId: statement.sourceId,
      note: `content-policy: ${reasons.join(', ')}`,
      after: JSON.stringify({ s: statement.s, p: statement.p, o: statement.o, status: 'rejected' }),
    }));
  }
  for (const statement of plan.statements) {
    await db.changelog.add(changeLogRow({
      action: sourceId ? 'ingest' : 'add',
      statementId: statement.id,
      sourceId: statement.sourceId,
      after: JSON.stringify({ s: statement.s, p: statement.p, o: statement.o, status: statement.status }),
    }));
  }
}

function afterStatementsPersisted(plan: PreparedStatementWrite, sourceId?: string) {
  const cleanedSts = plan.statements;
  _statements = [..._statements, ...cleanedSts];
  scheduleAutoSave();
  scheduleWorkspaceTtlExport();
  scheduleDrivePush();

  // "Email me when there's something to review" (F73): one best-effort n8n
  // webhook per batch of new PENDING facts — grant scrapes (currents), pod
  // arrivals, and any ingest all funnel through here. Fire-and-forget so a
  // slow/absent n8n never blocks the edit; no-ops unless the user opted in.
  const newPending = cleanedSts.filter((st) => st.status === 'pending');
  if (newPending.length > 0) {
    void import('$lib/integrations/n8n/notify')
      .then(({ reviewNotifyEnabled, notifyReview }) => {
        if (!reviewNotifyEnabled()) return;
        return notifyReview({
          count: newPending.length,
          kind: plan.opts?.origin === 'current' ? 'pod' : 'ingest',
          samples: newPending.slice(0, 5).map((st) => st.s.value.split('/').pop() ?? st.s.value),
        });
      })
      .catch(() => { /* best-effort notification */ });
  }
}

export async function addStatements(
  sts: Statement[],
  sourceId?: string,
  opts?: StatementWriteOptions,
) {
  const plan = await prepareStatementsForWrite(sts, sourceId, opts);
  if (plan.statements.length === 0 && plan.blocked.length === 0) return;
  await db.transaction('rw', db.statements, db.changelog, async () => {
    if (plan.statements.length > 0) await db.statements.bulkPut(plan.statements);
    await writeStatementChangeLog(plan, sourceId);
  });
  if (plan.statements.length > 0) afterStatementsPersisted(plan, sourceId);
}

/**
 * Ingest's terminal write boundary. It deliberately consumes a plan produced by the same
 * admission funnel as addStatements(), so content and archive policy cannot be bypassed merely
 * to obtain atomic source/run persistence. A transaction failure updates no reactive state and
 * commits none of source, accepted statements, changelog entries, or the terminal run.
 */
export async function persistIngestBatch(
  source: Source,
  plan: PreparedStatementWrite,
  terminalRun: ExtractionRun,
): Promise<Statement[]> {
  // A graph switch between preflight and commit must be visible to ingest. Silently returning
  // would leave the already-recorded persist stage looking successful while neither the source
  // nor terminal run was committed.
  if (isReadOnly()) throw new Error('Cannot persist an ingest while the official graph is active');
  const persistedRun = JSON.parse(JSON.stringify(terminalRun)) as ExtractionRun;
  await db.transaction('rw', db.sources, db.statements, db.extractionRuns, db.changelog, async () => {
    await db.sources.put(source);
    if (plan.statements.length > 0) await db.statements.bulkPut(plan.statements);
    await db.extractionRuns.put(persistedRun);
    await writeStatementChangeLog(plan, source.id);
  });

  _sources = [source, ..._sources];
  for (const hook of _afterAddSourceHooks) {
    try {
      hook(source);
    } catch (error) {
      // Post-commit observers are not part of the durable ingest boundary. Re-throwing here would
      // falsely turn a committed run into a failed one.
      console.error('[ingest] after-add-source hook failed:', error);
    }
  }
  if (plan.statements.length > 0) {
    afterStatementsPersisted(plan, source.id);
  } else {
    // A source retained with every candidate policy-held is still a durable ingest result and must
    // reach the same backup/export path, even though it has no pending-review notification.
    scheduleAutoSave();
    scheduleWorkspaceTtlExport();
    scheduleDrivePush();
  }
  return plan.statements;
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
  scheduleDrivePush();
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
  scheduleDrivePush();
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
  scheduleDrivePush();
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
