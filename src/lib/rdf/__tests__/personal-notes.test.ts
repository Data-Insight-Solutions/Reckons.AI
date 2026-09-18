import { describe, expect, it } from 'vitest';
import { captureRows, captureBatch, transferBatch, transferId, DERIVED_FROM } from '../personal-notes';
import { CAPTURED_NOTE } from '../captured-notes';
import { toTurtleFull } from '../serialize';
import { importTurtleFull } from '../import-ttl';

const entry = { subject: 'urn:test:note', predicate: CAPTURED_NOTE, object: 'My exact words.\n\nSecond paragraph. ',
  objectKind: 'literal' as const, kb: 'Work', addedAt: '2026-09-14T12:00:00.000Z', agent: 'ios-shortcut' };

describe('personal capture and reviewed dissemination', () => {
  it('collects capture rows independently of their requested destination, retaining unrelated and malformed rows', () => {
    const line = JSON.stringify(entry);
    expect(captureRows([line, '{invalid', JSON.stringify({ ...entry, predicate: 'urn:test:claim' }),
      JSON.stringify({ ...entry, objectKind: 'iri', object: 'urn:test:other' })].join('\n')))
      .toEqual([{ line, entry }]);
    expect(captureRows(JSON.stringify({ ...entry, kb: undefined }))).toEqual([]);
  });

  it('preserves the words and uses stable ids for retry, while producer trust never settles claims', () => {
    const first = captureBatch('inbox', entry);
    const second = captureBatch('inbox', { ...entry, verifiedBy: 'trust-me', kb: 'Elsewhere' });
    expect(first).toEqual(second);
    expect(first.statement.o.value).toBe(entry.object);
    expect(first.statement.status).toBe('pending');
    expect(first.source.trustLevel).toBe('review');
    expect(captureBatch('other-inbox', entry).statement.id).not.toBe(first.statement.id);
  });

  it('transfers exactly the reviewed text, independently per destination and revision', async () => {
    const text = 'Only the project paragraph.';
    const id = transferId('inbox', entry.subject, 'project', text);
    const batch = transferBatch({ id, inboxId: 'inbox', noteIri: entry.subject, destinationId: 'project', text,
      approvedAt: Date.parse(entry.addedAt), state: 'approved' });
    expect(batch.statements[0].o.value).toBe(text);
    expect(batch.statements[1].p.value).toBe(DERIVED_FROM);
    expect(batch.statements[1].o.value).toBe(entry.subject);
    expect(JSON.stringify(batch)).not.toContain(entry.object);
    expect(batch.statements.every((s) => s.status === 'pending')).toBe(true);
    expect(transferId('inbox', entry.subject, 'second-project', text)).not.toBe(id);
    expect(transferId('inbox', entry.subject, 'project', `${text} Revised.`)).not.toBe(id);
    const roundtrip = await importTurtleFull(toTurtleFull(batch.statements, [batch.source]));
    expect(roundtrip.statements).toHaveLength(2);
    expect(roundtrip.statements.find((s) => s.p.value === CAPTURED_NOTE)?.o.value).toBe(text);
    expect(roundtrip.sources[0].uri).toBe(entry.subject);
  });
});
