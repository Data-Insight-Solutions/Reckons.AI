/** Capture is independent of the graph being viewed. Delivery requires a separate human approval. */
import { v5 as uuidv5 } from 'uuid';
import { CAPTURED_NOTE } from './captured-notes';
import { parsePendingEntryLine, type PendingEntry } from './pending-entry';
import type { Source, Statement } from './types';

export const NOTES_NAMESPACE = uuidv5('https://reckons.ai/personal-notes', uuidv5.URL);
export const DERIVED_FROM = 'http://www.w3.org/ns/prov#wasDerivedFrom';

export type NotesPolicy = {
  id: 'main';
  inboxId: string;
  /** Local immutable database ids. Names, transcripts and imported metadata cannot grant access. */
  allowedGraphIds: string[];
};

export type NoteTransfer = {
  id: string;
  inboxId: string;
  noteIri: string;
  destinationId: string;
  /** Exactly the text displayed at approval, never re-read from a changing source. */
  text: string;
  approvedAt: number;
  state: 'approved' | 'delivered' | 'cancelled';
  deliveredAt?: number;
  error?: string;
};

export function isCaptureEntry(entry: PendingEntry): boolean {
  return entry.predicate === CAPTURED_NOTE && typeof entry.object === 'string' &&
    !!entry.object.trim() && entry.objectKind !== 'iri' &&
    (entry.objectKind === 'literal' || !/^(?:https?:|urn:)/i.test(entry.object));
}

export function captureRows(text: string): { line: string; entry: PendingEntry }[] {
  return text.split('\n').flatMap((line) => {
    const parsed = parsePendingEntryLine(line, { requireKb: true });
    return parsed.ok && isCaptureEntry(parsed.entry) ? [{ line, entry: parsed.entry }] : [];
  });
}

export function transferId(inboxId: string, noteIri: string, destinationId: string, text: string): string {
  return uuidv5(JSON.stringify([inboxId, noteIri, destinationId, text]), NOTES_NAMESPACE);
}

export function captureBatch(graphId: string, entry: PendingEntry): { source: Source; statement: Statement } {
  if (!isCaptureEntry(entry)) throw new Error('Expected a nonempty captured note');
  const id = uuidv5(JSON.stringify([graphId, entry.subject]), NOTES_NAMESPACE);
  const time = entry.addedAt ? Date.parse(entry.addedAt) : Date.now();
  const source: Source = {
    id: `note-${id}`, title: 'Personal note', uri: entry.subject,
    kind: 'note', trustLevel: 'review', ingestedAt: time,
  };
  return { source, statement: {
    id, sourceId: source.id,
    s: { kind: 'iri', value: entry.subject },
    p: { kind: 'iri', value: CAPTURED_NOTE },
    o: { kind: 'literal', value: entry.object! },
    g: { kind: 'iri', value: `urn:kbase:source/${source.id}` },
    status: 'pending', confidence: 1, createdAt: time, updatedAt: time,
    ...(entry.agent ? { proposedBy: entry.agent } : {}),
  } };
}

/** Only the approved text and an opaque provenance link leave the inbox. No source transcript copy. */
export function transferBatch(transfer: NoteTransfer): { source: Source; statements: Statement[] } {
  const noteIri = `urn:kbase:concept/note-transfer-${transfer.id}`;
  const { source, statement } = captureBatch(transfer.destinationId, {
    subject: noteIri, predicate: CAPTURED_NOTE, object: transfer.text, objectKind: 'literal',
    addedAt: new Date(transfer.approvedAt).toISOString(),
  });
  source.title = 'Reviewed note from Personal Notes';
  source.uri = transfer.noteIri;
  return { source, statements: [statement, {
    ...statement, id: `${statement.id}-provenance`,
    p: { kind: 'iri', value: DERIVED_FROM }, o: { kind: 'iri', value: transfer.noteIri },
  }] };
}
