/**
 * A fact id becomes part of <urn:kbase:stmt/{id}> in annotated Turtle. Ids such as
 * `currents|<subject>|<predicate>|<value>` contain characters a Turtle IRI cannot hold (the pipe), which made
 * a whole written file unparseable from that line on. Writing must escape them and reading must
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

describe('fact ids that are not IRI-safe', () => {
  const ids = [
    'cfe418d7-6a96-4fe2-a7bd-7a67d0ac8824',
    'currents|urn:reckons:currents/new-current|urn:reckons:meta/currents/cadenceMinutes|360',
    'arrival|urn:reckons:currents/article/x|urn:reckons:meta/title|A "quoted" title',
    'archive/e1/p/value%7Cwith-literal-escape',
    '100%|done',
    '~starts-with-the-marker',
  ];
  it('the written file parses, and every id comes back identical', async () => {
    const ttl = toTurtleFull(ids.map(st), [source], {});
    expect(ttl).not.toContain('<urn:kbase:stmt/currents|');
    const back = await importTurtleFull(ttl, { name: 'fixture.ttl' });
    expect(back.statements.map((x) => x.id).sort()).toEqual([...ids].sort());
  });
  it('an id with nothing unsafe is written as it was, and an unmarked escape is not decoded', async () => {
    const ttl = toTurtleFull([st('cfe418d7-6a96-4fe2-a7bd-7a67d0ac8824'), st('archive/e1/p/value%7Cx')], [source], {});
    expect(ttl).toContain('<urn:kbase:stmt/cfe418d7-6a96-4fe2-a7bd-7a67d0ac8824>');
    expect(ttl).toContain('<urn:kbase:stmt/archive/e1/p/value%7Cx>');
    const back = await importTurtleFull(ttl, { name: 'fixture.ttl' });
    expect(back.statements.map((x) => x.id)).toContain('archive/e1/p/value%7Cx');
  });
});
