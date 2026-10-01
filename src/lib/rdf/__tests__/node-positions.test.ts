import { describe, it, expect } from 'vitest';
import { isMetaPredicate, type Statement } from '../types';
import { NAV_X, NAV_Y, positionsFrom, positionWrites } from '../node-positions';

const st = (s: string, p: string, o: string, extra: Partial<Statement> = {}): Statement => ({
  id: `${s}|${p}`, s: { kind: 'iri', value: s }, p: { kind: 'iri', value: p }, o: { kind: 'literal', value: o },
  g: { kind: 'iri', value: 'urn:kbase:source/manual' }, sourceId: 'manual', confidence: 1, status: 'confirmed', createdAt: 0, updatedAt: 0, ...extra,
} as Statement);

describe('positionsFrom', () => {
  it('reads a node placed with both coordinates', () => {
    expect(positionsFrom([st('urn:a', NAV_X, '12.5'), st('urn:a', NAV_Y, '-3')])).toEqual(new Map([['urn:a', { x: 12.5, y: -3 }]]));
  });
  it('ignores half a position, junk numbers, and rejected statements', () => {
    const out = positionsFrom([
      st('urn:a', NAV_X, '1'),
      st('urn:b', NAV_X, 'nope'), st('urn:b', NAV_Y, '2'),
      st('urn:c', NAV_X, '1', { status: 'rejected' }), st('urn:c', NAV_Y, '2'),
    ]);
    expect(out.size).toBe(0);
  });
});

describe('positionWrites', () => {
  it('adds two confirmed coordinate facts the first time, rounded to one decimal', () => {
    const { updates, adds } = positionWrites('urn:a', 10.04, -2.26, []);
    expect(updates).toEqual([]);
    expect(adds.map((a) => [a.p.value, a.o.value, a.status, a.sourceId])).toEqual([[NAV_X, '10', 'confirmed', 'manual'], [NAV_Y, '-2.3', 'confirmed', 'manual']]);
  });
  it('updates in place on later drags instead of piling up facts', () => {
    const existing = [st('urn:a', NAV_X, '10'), st('urn:a', NAV_Y, '-2.3')];
    const { updates, adds } = positionWrites('urn:a', 15, -2.3, existing);
    expect(adds).toEqual([]);
    expect(updates).toEqual([{ id: 'urn:a|' + NAV_X, value: '15' }]);
  });
  it('round-trips: what it writes is what positionsFrom reads', () => {
    const { adds } = positionWrites('urn:a', 3.14, 2.71, []);
    expect(positionsFrom(adds).get('urn:a')).toEqual({ x: 3.1, y: 2.7 });
  });
});

describe('positions stay out of the graph', () => {
  it('hnav:x and hnav:y are meta predicates — never drawn as edges or reviewed as facts', () => {
    expect(isMetaPredicate(NAV_X)).toBe(true);
    expect(isMetaPredicate(NAV_Y)).toBe(true);
  });
});
