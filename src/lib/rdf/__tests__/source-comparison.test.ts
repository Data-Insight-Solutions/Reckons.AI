import { describe, it, expect } from 'vitest';
import {
  buildComparisonStatements,
  readComparisons,
  comparisonLink,
  comparisonId,
  formatElapsed,
  COMPARISON_FAILED_B,
} from '../source-comparison';

let n = 0;
const makeId = () => `id${n++}`;

describe('source comparison record', () => {
  it('records the name, both source ids and the time, and reads them back', () => {
    const sts = buildComparisonStatements({
      id: 'x-1', name: ' Page A vs B ', a: { sourceId: 'src-a' }, b: { sourceId: 'src-b' }, makeId, now: Date.UTC(2026, 10, 24),
    });
    expect(sts.every((s) => s.status === 'confirmed')).toBe(true);
    const [c] = readComparisons(sts);
    expect(c).toEqual({
      id: 'x-1', name: 'Page A vs B', madeAt: Date.UTC(2026, 10, 24), a: 'src-a', b: 'src-b', failedA: null, failedB: null,
    });
  });

  it('records a failed side with its reason and no source id for it', () => {
    const sts = buildComparisonStatements({
      id: 'x-2', name: 'n', a: { sourceId: 'src-a' }, b: { failed: 'Reader failed: 404' }, makeId,
    });
    expect(sts.some((s) => s.p.value === COMPARISON_FAILED_B && s.o.value === 'Reader failed: 404')).toBe(true);
    const [c] = readComparisons(sts);
    expect(c.b).toBeNull();
    expect(c.failedB).toBe('Reader failed: 404');
  });

  it('ignores rejected rows and unrelated statements, and sorts newest first', () => {
    const old = buildComparisonStatements({ id: 'o', name: 'old', a: { sourceId: '1' }, b: { sourceId: '2' }, makeId, now: 1000 });
    const fresh = buildComparisonStatements({ id: 'f', name: 'fresh', a: { sourceId: '3' }, b: { sourceId: '4' }, makeId, now: 2000 });
    const dead = buildComparisonStatements({ id: 'd', name: 'dead', a: { sourceId: '5' }, b: { sourceId: '6' }, makeId, now: 3000 })
      .map((s) => ({ ...s, status: 'rejected' as const }));
    expect(readComparisons([...old, ...dead, ...fresh]).map((c) => c.id)).toEqual(['f', 'o']);
  });

  it('builds the layout link of the agreed contract, leaving out a side that did not arrive', () => {
    expect(comparisonLink({ a: 'sa', b: 'sb' })).toBe('/?layout=compare&a=sa&b=sb');
    expect(comparisonLink({ a: 'sa', b: null })).toBe('/?layout=compare&a=sa');
    expect(comparisonLink({ a: null, b: null })).toBeNull();
  });

  it('makes a readable id and an honest elapsed time', () => {
    expect(comparisonId('Pricing: Acme vs. Beta!', 'k3')).toBe('pricing-acme-vs-beta-k3');
    expect(comparisonId('???', 'k3')).toBe('comparison-k3');
    expect(formatElapsed(42_400)).toBe('42 s');
    expect(formatElapsed(185_000)).toBe('3 min 05 s');
  });
});
