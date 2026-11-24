import { describe, it, expect } from 'vitest';
import type { Statement } from '../types';
import {
  RECKONING_TYPE, RECKONING_PREDICATES, reckoningStatements, readReckoning, groupByStanding, statementsTouching,
  reckoningStatementIri, statementIdOfIri,
} from '../reckoning-entity';

const st = (id: string, s: string, o: string, extra: Partial<Statement> = {}): Statement => ({
  id, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: 'urn:kbase:predicate/uses' },
  o: { kind: 'literal', value: o }, g: { kind: 'iri', value: 'urn:kbase:source/a' },
  sourceId: 'a', status: 'confirmed', confidence: 1, createdAt: 1, updatedAt: 1, ...extra,
});

describe('reckoning entity', () => {
  it('writes one typed entity with a link per chosen fact and the note, all confirmed', () => {
    const rows = reckoningStatements('r1', ['a', 'b', 'c', 'a'], ' We must pick one ', 5);
    expect(rows.filter((r) => r.p.value === RECKONING_PREDICATES.situationStatement)).toHaveLength(3);
    expect(rows.find((r) => r.p.value === RECKONING_PREDICATES.situationNote)?.o.value).toBe('We must pick one');
    expect(rows.some((r) => r.o.value === RECKONING_TYPE)).toBe(true);
    expect(rows.every((r) => r.status === 'confirmed')).toBe(true);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });
  it('reads the selection back, including ids an IRI cannot hold', () => {
    const rows = reckoningStatements('r2', ['plain', 'cur|s|p'], 'n', 1);
    expect(readReckoning(rows, 'r2')).toMatchObject({ note: 'n', statementIds: ['plain', 'cur|s|p'] });
    expect(readReckoning(rows, 'other')).toBeNull();
    expect(statementIdOfIri(reckoningStatementIri('cur|s|p'))).toBe('cur|s|p');
    expect(statementIdOfIri('urn:other')).toBeNull();
  });
  it('omits the note row when there is no sentence', () => {
    const rows = reckoningStatements('r3', ['a'], '  ', 1);
    expect(rows.some((r) => r.p.value === RECKONING_PREDICATES.situationNote)).toBe(false);
  });
  it('groups by standing, searches, and never offers its own rows', () => {
    const all = [
      st('1', 'urn:x:a', 'alpha'), st('2', 'urn:x:b', 'beta', { status: 'pending' }),
      st('3', 'urn:x:c', '?', { status: 'pending', needsObject: true }), ...reckoningStatements('r', ['1'], 'x', 1),
    ];
    const groups = groupByStanding(all, '', (i) => i);
    expect(groups.map((g) => g.standing)).toEqual(['held', 'pending', 'question']);
    expect(groups.flatMap((g) => g.rows).some((s) => s.sourceId === 'reckoning-r')).toBe(false);
    expect(groupByStanding(all, 'alpha', (i) => i).flatMap((g) => g.rows).map((s) => s.id)).toEqual(['1']);
  });
  it('puts chosen facts first in their group, so a chosen fact past the 40 shown rows can still be unticked', () => {
    const all = Array.from({ length: 50 }, (_, i) => st(`h${i}`, `urn:x:e${i}`, `v${i}`));
    const held = groupByStanding(all, '', (i) => i, new Set(['h45', 'h47'])).find((g) => g.standing === 'held')!;
    expect(held.rows.slice(0, 2).map((s) => s.id)).toEqual(['h45', 'h47']);
    expect(held.rows.slice(0, 40).map((s) => s.id)).toContain('h47');
    expect(held.rows.slice(2, 5).map((s) => s.id)).toEqual(['h0', 'h1', 'h2']);
    expect(groupByStanding(all, '', (i) => i)[0].rows.slice(0, 3).map((s) => s.id)).toEqual(['h0', 'h1', 'h2']);
  });
  it('finds facts touching picked entities, held first', () => {
    const all = [st('1', 'urn:x:a', 'v', { status: 'pending' }), st('2', 'urn:x:a', 'w'), st('3', 'urn:x:z', 'q')];
    expect(statementsTouching(all, new Set(['urn:x:a'])).map((s) => s.id)).toEqual(['2', '1']);
  });
});
