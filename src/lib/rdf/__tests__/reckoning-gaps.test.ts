import { describe, it, expect } from 'vitest';
import { computeGaps } from '../reckoning-gaps';
import type { Statement } from '../types';

const NS = 'urn:test:';
const iri = (v: string) => ({ kind: 'iri', value: NS + v }) as never;
let n = 0;
function st(s: string, p: string, o: string, over: Partial<Statement> = {}): Statement {
  n += 1;
  return {
    id: `st${n}`, s: iri(s), p: iri(p), o: iri(o), g: iri('g'), sourceId: 'src', confidence: 1,
    status: 'confirmed', createdAt: n, ...over,
  } as Statement;
}
const question = (s: string, p: string, over: Partial<Statement> = {}) =>
  st(s, p, '?', { needsObject: true, status: 'pending', question: 'what?', ...over });
const req = (s: string, p: string, o?: string) => ({ s: s.startsWith('?') ? s : NS + s, p: NS + p, ...(o ? { o: NS + o } : {}) });

describe('computeGaps', () => {
  it('reports an unmet requirement and omits a met one', () => {
    const facts = [st('a', 'has', 'x')];
    const gaps = computeGaps({ id: 't', requirements: [req('a', 'has'), req('b', 'has', 'y')] }, [], facts);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ subject: NS + 'b', predicate: NS + 'has', expectedObject: NS + 'y', kind: 'target-requirement' });
    expect(gaps[0].why).toMatch(/needs a reviewed fact/);
  });

  it('does not let a pending fact meet a requirement', () => {
    const facts = [st('a', 'has', 'x', { status: 'pending' })];
    const gaps = computeGaps({ id: 't', requirements: [req('a', 'has')] }, [], facts);
    expect(gaps.map((g) => g.kind)).toEqual(['target-requirement']);
  });

  it('returns nothing for an empty target with no questions', () => {
    expect(computeGaps({ id: 't', requirements: [] }, [], [st('a', 'has', 'x')])).toEqual([]);
  });

  it('links open questions by subject: situation fact id, situation IRI, or requirement subject', () => {
    const base = st('a', 'has', 'x');
    const qSituation = question('a', 'color');
    const qIri = question('c', 'size');
    const qReq = question('b', 'owner');
    const qOther = question('z', 'noise');
    const gaps = computeGaps(
      { id: 't', requirements: [req('b', 'has')] },
      [base.id, NS + 'c'],
      [base, qSituation, qIri, qReq, qOther],
    );
    const ids = gaps.filter((g) => g.kind === 'open-question').map((g) => g.questionId);
    expect(ids).toContain(qSituation.id);
    expect(ids).toContain(qIri.id);
    expect(ids).toContain(qReq.id);
    expect(ids).not.toContain(qOther.id);
    expect(gaps.find((g) => g.questionId === qReq.id)!.citations).toEqual([qReq.id]);
  });

  it('ignores rejected and superseded questions', () => {
    const gaps = computeGaps({ id: 't', requirements: [] }, [NS + 'a'],
      [question('a', 'p', { status: 'rejected' }), question('a', 'q', { status: 'superseded' })]);
    expect(gaps).toEqual([]);
  });

  it('ranks requirements, then questions sharing a requirement subject, then the rest, stably', () => {
    const qRest1 = question('s1', 'p');
    const qLinked1 = question('b', 'p1');
    const qRest2 = question('s2', 'p');
    const qLinked2 = question('b', 'p2');
    const gaps = computeGaps({ id: 't', requirements: [req('b', 'has'), req('c', 'has')] }, [NS + 's1', NS + 's2'],
      [qRest1, qLinked1, qRest2, qLinked2]);
    expect(gaps.map((g) => g.kind)).toEqual(['target-requirement', 'target-requirement', 'open-question', 'open-question', 'open-question', 'open-question']);
    expect(gaps.slice(2).map((g) => g.questionId)).toEqual([qLinked1.id, qLinked2.id, qRest1.id, qRest2.id]);
  });

  it('cites situation facts about a requirement subject', () => {
    const f = st('b', 'name', 'x');
    const gaps = computeGaps({ id: 't', requirements: [req('b', 'has')] }, [f.id], [f]);
    expect(gaps[0].citations).toEqual([f.id]);
  });

  it('reports a placeholder subject as a gap and says it is a placeholder', () => {
    const gaps = computeGaps({ id: 't', requirements: [req('?asset', 'has')] }, [], []);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].subject).toBe('?asset');
    expect(gaps[0].why).toMatch(/placeholder/);
    expect(gaps[0].citations).toEqual([]);
  });

  it('keeps a literal expected object', () => {
    const gaps = computeGaps({ id: 't', requirements: [{ s: NS + 'a', p: NS + 'p', o: { literal: 'v' } }] }, [], []);
    expect(gaps[0].expectedObject).toEqual({ literal: 'v' });
  });
});
