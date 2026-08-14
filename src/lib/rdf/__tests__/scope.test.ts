import { describe, it, expect } from 'vitest';
import {
  measureCreep,
  creepRatio,
  creepSeries,
  creepShape,
  shouldWarnOnCreep,
  describeCreep,
  type ScopeEstimate,
  type ScopeObservation,
} from '../scope';

describe('measureCreep', () => {
  it('reports the overrun per dimension', () => {
    const r = measureCreep({ files: 3, dependencies: 0 }, { files: 7, dependencies: 1 });
    expect(r.find((x) => x.dimension === 'files')).toMatchObject({ over: 4, actual: 7 });
    expect(r.find((x) => x.dimension === 'dependencies')!.over).toBe(1);
  });

  it('reports zero overrun when the work stayed inside the estimate', () => {
    const r = measureCreep({ files: 10 }, { files: 4 });
    expect(r[0].over).toBe(0);
    expect(r[0].ratio).toBeLessThan(1);
  });

  it('SKIPS dimensions the estimate is silent about, rather than treating them as zero', () => {
    // An estimate that never mentioned dependencies is not a claim that there would be none.
    // Scoring silence as a breach would penalise partial estimates out of existence.
    const r = measureCreep({ files: 3 }, { files: 3, dependencies: 5 });
    expect(r.map((x) => x.dimension)).toEqual(['files']);
  });

  it('treats work against a zero estimate as infinite creep', () => {
    // "no new dependencies" that acquired one is an unbounded surprise, not a 100% overrun.
    const r = measureCreep({ dependencies: 0 }, { dependencies: 1 });
    expect(r[0].ratio).toBe(Infinity);
  });

  it('does not call a zero estimate met with zero work a breach', () => {
    expect(measureCreep({ dependencies: 0 }, { dependencies: 0 })[0].ratio).toBe(1);
  });
});

describe('creep as a SERIES — the gradual growing of an expectation', () => {
  const estimate: ScopeEstimate = { files: 4 };

  it('shows the expectation growing reading by reading', () => {
    const obs: ScopeObservation[] = [
      { at: 1, actual: { files: 2 } },
      { at: 2, actual: { files: 5 }, discovered: 'attribution had to survive serialization' },
      { at: 3, actual: { files: 8 }, discovered: 'import had to read it back' },
    ];
    const s = creepSeries(estimate, obs);
    expect(s.map((x) => x.ratio)).toEqual([0.5, 1.25, 2]);
    expect(s[2].discovered).toMatch(/read it back/);
  });

  it('orders observations by time regardless of input order', () => {
    const s = creepSeries(estimate, [
      { at: 3, actual: { files: 8 } },
      { at: 1, actual: { files: 2 } },
    ]);
    expect(s[0].at).toBe(1);
  });

  it('calls steady growth across readings GRADUAL — the design was under-refined', () => {
    const s = creepSeries(estimate, [
      { at: 1, actual: { files: 3 } },
      { at: 2, actual: { files: 6 } },
      { at: 3, actual: { files: 9 } },
    ]);
    expect(creepShape(s)).toBe('gradual');
  });

  it('calls a single jump a STEP — one specific thing was missed', () => {
    const s = creepSeries(estimate, [
      { at: 1, actual: { files: 2 } },
      { at: 2, actual: { files: 9 } },
    ]);
    expect(creepShape(s)).toBe('step');
  });

  it('calls staying inside the estimate NONE', () => {
    const s = creepSeries(estimate, [
      { at: 1, actual: { files: 1 } },
      { at: 2, actual: { files: 3 } },
    ]);
    expect(creepShape(s)).toBe('none');
  });

  it('handles an empty series', () => {
    expect(creepShape([])).toBe('none');
  });
});

describe('shouldWarnOnCreep — soft and tolerant by design', () => {
  it('does not warn on a small overrun', () => {
    // "about three files" costing four reveals nothing; warning would train people to
    // ignore the signal.
    expect(shouldWarnOnCreep(measureCreep({ files: 3 }, { files: 4 }))).toBe(false);
  });

  it('warns once the overrun is real', () => {
    expect(shouldWarnOnCreep(measureCreep({ files: 3 }, { files: 9 }))).toBe(true);
  });

  it('warns on an unexpected dependency against a zero estimate', () => {
    expect(shouldWarnOnCreep(measureCreep({ dependencies: 0 }, { dependencies: 1 }))).toBe(true);
  });

  it('respects a caller-set tolerance', () => {
    const r = measureCreep({ files: 4 }, { files: 8 });
    expect(shouldWarnOnCreep(r, 1.5)).toBe(true);
    expect(shouldWarnOnCreep(r, 3)).toBe(false);
  });
});

describe('describeCreep — evidence about the DESIGN, never about the implementer', () => {
  it('says nothing happened when the work stayed in scope', () => {
    expect(describeCreep(measureCreep({ files: 5 }, { files: 2 }), 'none')).toMatch(/stayed within/);
  });

  it('attributes gradual creep to an under-refined design', () => {
    const msg = describeCreep(measureCreep({ files: 3 }, { files: 9 }), 'gradual', [
      'serialization had to carry attribution',
    ]);
    expect(msg).toMatch(/systematically under-refined/);
    expect(msg).toMatch(/serialization had to carry attribution/);
    expect(msg).toMatch(/not a failure of the work/);
  });

  it('attributes a step to one missed thing', () => {
    expect(describeCreep(measureCreep({ files: 3 }, { files: 9 }), 'step')).toMatch(/missed one thing/);
  });

  it('never phrases the finding as blame', () => {
    const msg = describeCreep(measureCreep({ files: 2 }, { files: 20 }), 'gradual');
    expect(msg).not.toMatch(/should have|failed to estimate|too slow/i);
    expect(msg).toMatch(/refine the design/);
  });
});

describe('this session as a worked example', () => {
  it('records F129 attribution as creep that refined the design', () => {
    // The plan said "add a yield metric". It did not say serialize.ts and import-ttl.ts
    // would have to change so attribution could survive an export.
    const s = creepSeries({ files: 2 }, [
      { at: 1, actual: { files: 1 }, discovered: 'proposedBy on Statement' },
      { at: 2, actual: { files: 3 }, discovered: 'toTurtleFull must emit it' },
      { at: 3, actual: { files: 5 }, discovered: 'importTurtleFull must read it back' },
    ]);
    expect(creepShape(s)).toBe('gradual');
    expect(shouldWarnOnCreep(measureCreep({ files: 2 }, { files: 5 }))).toBe(true);
  });
});
