import { describe, it, expect } from 'vitest';
import { buildNodeTimes, timelineRange, undatedCount } from '../timeline-layout';
import { termKey, type Statement, type ReviewStatus } from '../types';

const DUE = 'urn:kbase:predicate/due-at';
const SCHED = 'urn:kbase:predicate/scheduled-at';
const ENDS = 'urn:kbase:predicate/ends-at';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

let n = 0;
function st(
  subject: string,
  predicate: string,
  object: string,
  opts: { createdAt?: number; status?: ReviewStatus } = {},
): Statement {
  return {
    id: `s${++n}`,
    s: { kind: 'iri', value: subject },
    p: { kind: 'iri', value: predicate },
    o: { kind: 'literal', value: object },
    g: { kind: 'iri', value: 'urn:kbase:source/manual' },
    sourceId: 'manual',
    confidence: 1,
    status: opts.status ?? 'confirmed',
    createdAt: opts.createdAt ?? 1_700_000_000_000,
    updatedAt: 0,
  };
}

const A = 'urn:kbase:concept/dated-event';
const B = 'urn:kbase:concept/undated-thing';
const key = (iri: string) => termKey({ kind: 'iri', value: iri });

describe('buildNodeTimes — event mode', () => {
  it('places a node that has a date', () => {
    const t = buildNodeTimes([st(A, DUE, '2026-09-30')], 'event');
    expect(t.has(key(A))).toBe(true);
  });

  it('LEAVES AN UNDATED NODE OUT rather than giving it the ingestion time', () => {
    // The whole bug: 93% of starter-everyday was placed on the axis by createdAt.
    const t = buildNodeTimes([st(B, LABEL, 'A thing with no date')], 'event');
    expect(t.has(key(B))).toBe(false);
    expect(t.size).toBe(0);
  });

  it('keeps undated nodes out of the RANGE, so real dates are not compressed', () => {
    // dataMin/dataMax previously included fake ingestion times, squeezing genuine events
    // into a sliver of the axis.
    const IMPORT = Date.UTC(2026, 7, 13);
    const times = buildNodeTimes(
      [
        st(A, DUE, '2027-06-05', { createdAt: IMPORT }),
        st(B, LABEL, 'undated', { createdAt: IMPORT }),
      ],
      'event',
    );
    const range = timelineRange(times)!;
    expect(range.dataMin).toBe(Date.parse('2027-06-05T00:00:00') || range.dataMin);
    expect(range.dataMin).toBe(range.dataMax); // one dated node only
    expect(times.size).toBe(1);
  });

  it('uses the EARLIEST date so a thing with a start and an end sits at its start', () => {
    const t = buildNodeTimes([st(A, ENDS, '2026-12-31'), st(A, SCHED, '2026-01-01')], 'event');
    expect(t.get(key(A))).toBe(new Date(2026, 0, 1).getTime());
  });

  it('ignores an unparseable date rather than placing the node at NaN', () => {
    expect(buildNodeTimes([st(A, DUE, 'sometime next year')], 'event').size).toBe(0);
  });

  it('ignores the partial-fact placeholder', () => {
    // F32 writes object "?" for an unanswered question; that is not a date.
    expect(buildNodeTimes([st(A, DUE, '?')], 'event').size).toBe(0);
  });

  it('ignores rejected and superseded statements', () => {
    const t = buildNodeTimes(
      [
        st(A, DUE, '2026-09-30', { status: 'rejected' }),
        st(B, DUE, '2026-09-30', { status: 'superseded' }),
      ],
      'event',
    );
    expect(t.size).toBe(0);
  });

  it('does not treat a non-temporal predicate as a date', () => {
    // pred:deadline is the obvious modelling choice for a grant and is NOT recognised.
    const t = buildNodeTimes([st(A, 'urn:kbase:predicate/deadline', '2026-09-30')], 'event');
    expect(t.size).toBe(0);
  });
});

describe('buildNodeTimes — ingested mode', () => {
  it('gives every node its createdAt, including objects', () => {
    const t = buildNodeTimes([st(A, LABEL, 'x', { createdAt: 5000 })], 'ingested');
    expect(t.get(key(A))).toBe(5000);
    expect(t.size).toBe(2); // subject and the literal object
  });

  it('keeps the earliest arrival when a node appears twice', () => {
    const t = buildNodeTimes(
      [st(A, LABEL, 'x', { createdAt: 9000 }), st(A, DUE, '2026-01-01', { createdAt: 3000 })],
      'ingested',
    );
    expect(t.get(key(A))).toBe(9000); // first write wins, matching the renderers' behaviour
  });
});

describe('timelineRange', () => {
  it('returns null when nothing is dated — starter-guide has 216 nodes and no dates', () => {
    expect(timelineRange(new Map())).toBeNull();
  });

  it('never returns a zero range, which would divide by zero downstream', () => {
    expect(timelineRange(new Map([['a', 100]]))!.dataRange).toBe(1);
  });

  it('spans min to max', () => {
    const r = timelineRange(new Map([['a', 100], ['b', 500], ['c', 300]]))!;
    expect([r.dataMin, r.dataMax, r.dataRange]).toEqual([100, 500, 400]);
  });
});

describe('undatedCount', () => {
  it('counts the nodes destined for the lane', () => {
    const times = new Map([['a', 1]]);
    expect(undatedCount(['a', 'b', 'c'], times)).toBe(2);
  });
});
