import { v4 as uuid } from 'uuid';
import { KBaseDB, DEFAULT_SETTINGS } from './db';
import { appDb } from './app-db';
import { getRegistry, ensureKbRegistered, touchKb, type KbEntry } from './kb-registry';
import { normalizePendingGraphName } from '../rdf/pending-entry';
import type { PendingEntry } from '../rdf/pending-entry';
import { CAPTURED_NOTE } from '../rdf/captured-notes';
import { captureBatch, captureRows, transferBatch, transferId, type NotesPolicy, type NoteTransfer } from '../rdf/personal-notes';
import type { Source, Statement } from '../rdf/types';
import { classifyText } from '../safety/content-policy';

function writableGraph(id: string): KbEntry {
  const graph = getRegistry().find((entry) => entry.id === id);
  if (!graph || graph.archiveOf) throw new Error('This graph is unavailable or is an archive');
  return graph;
}

/** Reuses the existing Personal Notes graph; ambiguous names require a deliberate choice. */
export async function personalNotesPolicy(): Promise<NotesPolicy> {
  const current = await appDb.notesPolicy.get('main');
  if (current) { writableGraph(current.inboxId); return current; }
  const candidates = getRegistry().filter((entry) =>
    !entry.archiveOf && normalizePendingGraphName(entry.name) === 'personal-notes');
  if (candidates.length > 1) throw new Error('More than one graph is named Personal Notes. Rename the extra graph before setting up the inbox.');
  // A fixed id makes concurrent first captures converge on one graph.
  const inbox = candidates[0] ?? ensureKbRegistered('reckons-personal-notes', 'Personal Notes');
  const graph = new KBaseDB(inbox.id);
  try {
    await graph.transaction('rw', graph.settings, async () => {
      const settings = await graph.settings.get('main');
      if (!settings) await graph.settings.put({ ...DEFAULT_SETTINGS, kbTitle: inbox.name });
    });
  } finally { graph.close(); }
  return appDb.transaction('rw', appDb.notesPolicy, async () => {
    const existing = await appDb.notesPolicy.get('main');
    if (existing) return existing;
    const policy: NotesPolicy = { id: 'main', inboxId: inbox.id, allowedGraphIds: [] };
    await appDb.notesPolicy.add(policy);
    return policy;
  });
}

export async function allowNotesDestination(id: string, allowed: boolean): Promise<void> {
  return withTransferLock(() => setDestinationPermission(id, allowed));
}

/** Serialize permission changes and delivery across tabs; fail closed if that guard is unavailable. */
async function withTransferLock<T>(action: () => Promise<T>): Promise<T> {
  if (!globalThis.navigator?.locks) throw new Error('This browser cannot safely coordinate graph transfers. Your notes can still be saved here.');
  return navigator.locks.request('reckons:personal-notes-transfers', action);
}

async function setDestinationPermission(id: string, allowed: boolean): Promise<void> {
  writableGraph(id);
  const policy = await personalNotesPolicy();
  if (policy.inboxId === id) throw new Error('Personal Notes is already the inbox');
  await appDb.transaction('rw', appDb.notesPolicy, appDb.noteTransfers, async () => {
    const latest = (await appDb.notesPolicy.get('main'))!;
    const ids = new Set(latest.allowedGraphIds);
    if (allowed) ids.add(id); else ids.delete(id);
    await appDb.notesPolicy.put({ ...latest, allowedGraphIds: [...ids] });
    if (!allowed) {
      await appDb.noteTransfers.where('state').equals('approved').filter((t) => t.destinationId === id)
        .modify({ state: 'cancelled', error: 'Destination permission was removed. Review again to send.' });
    }
  });
}

function validateText(text: string): void {
  if (!text.trim()) throw new Error('Write something to save');
  if (text.length > 64_000) throw new Error('This note is too long; split it into smaller notes');
  if (classifyText(text).rating === 'blocked') throw new Error('This note was held by the content policy');
}

/** A narrow write path: raw notes only, no inferred claims or trusted status from a producer. */
async function persistCapture(id: string, entry: PendingEntry): Promise<boolean> {
  writableGraph(id);
  validateText(entry.object!);
  const { source, statement } = captureBatch(id, entry);
  const graph = new KBaseDB(id);
  try {
    const written = await graph.transaction('rw', graph.sources, graph.statements, graph.changelog, async () => {
      const existing = await graph.statements.where('[s.value+p.value]').equals([entry.subject, CAPTURED_NOTE]).toArray();
      if (existing.length) {
        // Preserve edits and review verdicts. A conflicting redelivery stays in the queue.
        if (existing.some((s) => s.o.kind !== 'literal' || s.o.value !== entry.object)) {
          throw new Error('This note identity already contains different text; queued original retained');
        }
        return false;
      }
      await writeBatch(graph, source, [statement]);
      return true;
    });
    if (written) touchKb(id);
    return written;
  } finally { graph.close(); }
}

async function writeBatch(graph: KBaseDB, source: Source, statements: Statement[]): Promise<void> {
  await graph.sources.add(source);
  await graph.statements.bulkAdd(statements);
  await graph.changelog.add({ timestamp: Date.now(), action: 'ingest', sourceId: source.id,
    note: source.title, after: JSON.stringify(statements.map((s) => s.id)) });
}

export async function savePersonalNote(text: string): Promise<string> {
  validateText(text);
  const policy = await personalNotesPolicy();
  const iri = `urn:kbase:concept/note-${uuid()}`;
  await persistCapture(policy.inboxId, {
    subject: iri, predicate: CAPTURED_NOTE, object: text, objectKind: 'literal', addedAt: new Date().toISOString(),
  });
  return iri;
}

/** Receipts are returned only after durable storage. Failed and non-capture rows remain untouched. */
export async function importPersonalCaptureRows(snapshot: string): Promise<{
  acknowledgedLines: string[]; written: number; inboxId?: string; held: number;
}> {
  const rows = captureRows(snapshot);
  if (!rows.length) return { acknowledgedLines: [], written: 0, held: 0 };
  const { inboxId } = await personalNotesPolicy();
  const acknowledgedLines: string[] = [];
  let written = 0, held = 0;
  for (const { line, entry } of rows) {
    try {
      if (await persistCapture(inboxId, entry)) written++;
      acknowledgedLines.push(line);
    } catch { held++; }
  }
  return { acknowledgedLines, written, inboxId, held };
}

/** Called only by the review action, never from a capture payload or model suggestion. */
export async function approveNoteTransfer(noteIri: string, destinationId: string, text: string): Promise<NoteTransfer> {
  validateText(text);
  const policy = await personalNotesPolicy();
  writableGraph(destinationId);
  const graph = new KBaseDB(policy.inboxId);
  try {
    const original = await graph.statements.where('[s.value+p.value]').equals([noteIri, CAPTURED_NOTE])
      .filter((s) => s.status !== 'rejected' && s.status !== 'superseded').first();
    if (!original) throw new Error('The original note is no longer available for review');
  } finally { graph.close(); }
  return appDb.transaction('rw', appDb.notesPolicy, appDb.noteTransfers, async () => {
    const latest = (await appDb.notesPolicy.get('main'))!;
    if (latest.inboxId === destinationId || !latest.allowedGraphIds.includes(destinationId)) {
      throw new Error('Allow this destination before approving a transfer');
    }
    const id = transferId(policy.inboxId, noteIri, destinationId, text);
    const existing = await appDb.noteTransfers.get(id);
    if (existing && existing.state !== 'cancelled') return existing;
    const transfer: NoteTransfer = { id, inboxId: policy.inboxId, noteIri, destinationId, text,
      approvedAt: Date.now(), state: 'approved' };
    await appDb.noteTransfers.put(transfer);
    return transfer;
  });
}

let delivering: Promise<string[]> | null = null;
export function deliverApprovedNoteTransfers(): Promise<string[]> {
  if (delivering) return delivering;
  delivering = (async () => {
    if (await appDb.noteTransfers.where('state').equals('approved').count() === 0) return [];
    return withTransferLock(deliverTransfers);
  })().finally(() => { delivering = null; });
  return delivering;
}

async function deliverTransfers(): Promise<string[]> {
  const writtenGraphs = new Set<string>();
  for (const transfer of await appDb.noteTransfers.where('state').equals('approved').toArray()) {
    let target: KBaseDB | undefined;
    try {
      writableGraph(transfer.destinationId);
      const { source, statements } = transferBatch(transfer);
      target = new KBaseDB(transfer.destinationId);
      // Check permission again on every attempt, including after a reload or a previous failure.
      const policy = await appDb.notesPolicy.get('main');
      const latest = await appDb.noteTransfers.get(transfer.id);
      if (!policy?.allowedGraphIds.includes(transfer.destinationId) || latest?.state !== 'approved') continue;
      await target.transaction('rw', target.sources, target.statements, target.changelog, async () => {
        const existing = await target!.sources.get(source.id);
        if (!existing) await writeBatch(target!, source, statements);
        // Source + statements commit together. Source is the receipt even after a human edits a copy.
      });
      await appDb.noteTransfers.update(transfer.id, { state: 'delivered', deliveredAt: Date.now(), error: undefined });
      touchKb(transfer.destinationId);
      writtenGraphs.add(transfer.destinationId);
    } catch (error) {
      await appDb.noteTransfers.update(transfer.id, { error: error instanceof Error ? error.message : 'Transfer failed; retry available' });
    } finally { target?.close(); }
  }
  return [...writtenGraphs];
}
