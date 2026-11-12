/**
 * A statement id becomes part of <urn:kbase:stmt/{id}> in annotated Turtle. Ids such as
 * `currents|<subject>|<predicate>|<value>` contain characters a Turtle IRI cannot hold (the pipe), which made
 * a whole exported space unparseable from that line on. The exporter must escape them and the importer must
 * give the original id back.
 */
import { describe, it, expect } from 'vitest';
import { toTurtleFull } from '../serialize';
import { importTurtleFull } from '../import-ttl';
import { iri, lit, type Source, type Statement } from '../types';

const source: Source = { id: 's1', title: 'Fixture', uri: 'note://fixture', ingestedAt: 1_700_000_000_000, kind: 'note' };
const st = (id: string): Statement => ({
  id, s: iri('urn:reckons:currents/new-current'), p: iri('urn:reckons:meta/currents/cadenceMinutes'), o: lit('360'),
  g: iri('urn:kbase:source/s1'), sourceId: 's1', confidence: 1, status: 'confirmed', createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000,
});

describe('statement ids that are not IRI-safe', () => {
  it('export parses, and the id round-trips', async () => {
    const id = 'currents|urn:reckons:currents/new-current|urn:reckons:meta/currents/cadenceMinutes|360';
    const ttl = toTurtleFull([st(id), st('plain-id')], [source], {});
    expect(ttl).not.toContain('<urn:kbase:stmt/currents|');
    const back = await importTurtleFull(ttl, { name: 'fixture.ttl' });
    expect(back.statements.map((x) => x.id).sort()).toEqual([id, 'plain-id'].sort());
    expect(back.statements.every((x) => x.status === 'confirmed')).toBe(true);
  });
});
