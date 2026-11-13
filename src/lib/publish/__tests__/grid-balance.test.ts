import { describe, it, expect } from 'vitest';
import { rowBalance, unbalancedRows, type Track, type Box } from '../../../../scripts/offline/grid-balance';

const two: Track[] = [{ x0: 0, x1: 100 }, { x0: 120, x1: 220 }];
const box = (left: number, top: number, right: number, bottom: number): Box => ({ left, top, right, bottom });

describe('grid balance row arithmetic', () => {
  it('a full row is balanced', () => {
    expect(unbalancedRows(rowBalance(two, [box(0, 0, 100, 50), box(120, 0, 220, 50)]))).toEqual([]);
  });
  it('a lone card in the right column leaves a gap at the START of the row', () => {
    const r = unbalancedRows(rowBalance(two, [box(0, 0, 100, 50), box(120, 0, 220, 50), box(120, 70, 220, 120)]));
    expect(r).toHaveLength(1);
    expect(r[0].startGap).toBe(true);
    expect(r[0].runs).toEqual([{ from: 0, to: 0 }]);
  });
  it('a lone card in the left column leaves a trailing gap', () => {
    const r = unbalancedRows(rowBalance(two, [box(0, 0, 100, 50)]));
    expect(r[0].endGap).toBe(true);
    expect(r[0].startGap).toBe(false);
  });
  it('a tall card keeps its column occupied in the rows it spans', () => {
    const rows = rowBalance(two, [box(0, 0, 100, 200), box(120, 0, 220, 50), box(120, 70, 220, 120), box(120, 140, 220, 190)]);
    expect(unbalancedRows(rows)).toEqual([]);
    expect(rows).toHaveLength(3);
  });
  it('a card spanning both columns fills its row', () => {
    expect(unbalancedRows(rowBalance(two, [box(0, 0, 220, 50)]))).toEqual([]);
  });
  it('counts a run of two empty columns in a 4-column grid', () => {
    const four: Track[] = [0, 1, 2, 3].map((i) => ({ x0: i * 60, x1: i * 60 + 50 }));
    const r = unbalancedRows(rowBalance(four, [box(0, 0, 50, 40), box(60, 0, 110, 40)]));
    expect(r[0].runs).toEqual([{ from: 2, to: 3 }]);
  });
});
