import { describe, expect, it } from 'vitest';
import { sampleRun } from '../run-sample';

// A row here has at least a `predicate` (the sampler's only requirement) plus a `seq` so the
// fixtures and the assertions can tell individual rows apart. All data is synthetic.
type Row = { predicate: string; seq: number };

/** `predicates` distinct predicates, `per` rows each = `predicates * per` rows. */
function fixture(predicates: number, per: number): Row[] {
  const rows: Row[] = [];
  let seq = 0;
  for (let p = 0; p < predicates; p++) {
    for (let r = 0; r < per; r++) rows.push({ predicate: `pred-${p}`, seq: seq++ });
  }
  return rows;
}

const predicatesIn = (rows: Row[]): Set<string> => new Set(rows.map((r) => r.predicate));
const bySeq = (rows: Row[]): Row[] => [...rows].sort((a, b) => a.seq - b.seq);

describe('sampleRun (F89.4.5 run sampler)', () => {
  it('1,200 rows over 5 predicates give 10 rows covering all 5, identical on a second call', () => {
    const rows = fixture(5, 240);
    expect(rows.length).toBe(1200);

    const first = sampleRun(rows, 'run-A');
    expect(first).toHaveLength(10);
    expect(predicatesIn(first).size).toBe(5); // every one of the five predicates is covered

    const second = sampleRun(rows, 'run-A');
    expect(second).toEqual(first); // same rows + same run id -> the same sample
  });

  it('3 rows give 3 rows', () => {
    const rows = fixture(3, 1); // three distinct predicates, one row each
    const out = sampleRun(rows, 'run-small');
    expect(out).toHaveLength(3);
    expect(bySeq(out)).toEqual(rows); // all three rows, none lost
  });

  it('12 predicates with size 10 give 10 distinct predicates', () => {
    const rows = fixture(12, 1);
    const out = sampleRun(rows, 'run-12', 10);
    expect(out).toHaveLength(10);
    expect(predicatesIn(out).size).toBe(10); // ten rows, ten distinct predicates
  });

  it('an empty list gives an empty list', () => {
    expect(sampleRun([], 'run-empty')).toEqual([]);
  });

  it('two different run ids over the same rows are each stable', () => {
    const rows = fixture(5, 240);
    expect(sampleRun(rows, 'run-alpha')).toEqual(sampleRun(rows, 'run-alpha'));
    expect(sampleRun(rows, 'run-beta')).toEqual(sampleRun(rows, 'run-beta'));
  });

  it('the seed is used: two different run ids give different samples over the same rich rows', () => {
    const rows = fixture(5, 240);
    expect(sampleRun(rows, 'run-alpha')).not.toEqual(sampleRun(rows, 'run-beta'));
  });
});
