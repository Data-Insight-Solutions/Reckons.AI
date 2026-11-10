import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';
import { deferredRows, measureOf, measureProducers, openByProducer, pausedProducers, producerKey, producerState, settledRows, tallyGraph, tallyPending, type Tally } from '../proposal-tally';
import { rowId } from '../../../../mcp-server/src/review-session';

describe('proposal tally', () => {
  it('counts queued lines as open, skipping malformed ones', () => {
    const r = tallyPending('{"agent":"offline:docs-review"}\nnot json\n\n{"agent":"offline:docs-review"}\n{}\n');
    expect(r.queued).toBe(3);
    expect(r.tallies.get('offline:docs-review')).toEqual({ proposed: 2, accepted: 0, rejected: 0, open: 2, deferred: 0 });
    expect(r.tallies.get('(unattributed)')?.open).toBe(1);
    // A non-string agent (found by the local review) is unattributed, never a crash downstream.
    const odd = tallyPending('{"agent":42}\n{"agent":{"x":1}}\n{"agent":""}\n');
    expect(odd.tallies.get('(unattributed)')?.open).toBe(3);
    expect(() => openByProducer(odd.tallies)).not.toThrow();
  });
  it('reads graph status: confirmed and refined accept, rejected rejects, anything else is open', () => {
    const ttl = `@prefix m: <urn:kbase:meta/> .
      <urn:s1> m:proposed-by "offline:layer-classify (qwen3:32b)" ; m:status "confirmed" .
      <urn:s2> m:proposed-by "offline:layer-classify (qwen3:32b)" ; m:status "rejected" .
      <urn:s3> m:proposed-by "offline:layer-classify (qwen3:32b)" ; m:status "pending" .
      <urn:s4> m:proposed-by "offline:layer-classify (qwen3:32b)" .`;
    const into = new Map<string, Tally>();
    expect(tallyGraph(new Parser().parse(ttl), into)).toBe(true);
    expect(into.get('offline:layer-classify (qwen3:32b)')).toEqual({ proposed: 4, accepted: 1, rejected: 1, open: 2, deferred: 0 });
  });
  it('maps every agent label of one job to the same producer and sums them', () => {
    expect(['offline:layer-classify (qwen3:32b)', 'offline:docs-expand:qwen3:32b', 'stars-scan', 'offline:code-review (qwen3-coder:latest)'].map(producerKey))
      .toEqual(['layer-classify', 'docs-expand', 'stars-scan', 'code-review']);
    const t = (open: number): Tally => ({ proposed: open, accepted: 0, rejected: 0, open, deferred: 0 });
    const m = openByProducer(new Map([['offline:docs-expand:qwen3:32b', t(40)], ['offline:docs-expand (gemma3:27b)', t(27)], ['stars-scan', t(81)]]));
    expect(m.get('docs-expand')).toBe(67);
    expect(m.get('stars-scan')).toBe(81);
  });

  it('counts a row with a journalled verdict as reviewed, not open (back-pressure)', () => {
    const rows = [1, 2, 3, 4].map((i) => ({ agent: 'offline:extraction-score', subject: `urn:s${i}`, predicate: 'urn:p', object: `o${i}`, kb: 'roadmap' }));
    const ids = rows.map((r) => rowId(r));
    const journal = [
      { verdict: 'reject', rows: [ids[0], ids[1]] },
      { verdict: 'accept', rows: [ids[2]] },
      { verdict: 'defer', rows: [ids[3]] },
    ].map((v) => JSON.stringify(v)).join('\n') + '\nnot json\n';
    const r = tallyPending(rows.map((x) => JSON.stringify(x)).join('\n'), new Map(), settledRows(journal), deferredRows(journal));
    expect(r.tallies.get('offline:extraction-score')).toEqual({ proposed: 4, accepted: 1, rejected: 2, open: 1, deferred: 1 });
    expect(openByProducer(r.tallies).get('extraction-score')).toBe(1);
  });
  it('an accept naming several rows covers none of them (the grouping bug)', () => {
    const settled = settledRows(JSON.stringify({ verdict: 'accept', rows: ['aaaaaaaa', 'bbbbbbbb'] }));
    expect(settled.size).toBe(0);
  });
});

// F89.4.6: the state function over fixtures. No live queue or journal is read.
const m = (accepted: number, rejected: number, deferred: number, open = 0) => measureOf({ proposed: accepted + rejected + deferred + open, accepted, rejected, open: open + deferred, deferred });

describe('producer state (F89.4.6)', () => {
  it('9 rows ruled on is sampling', () => {
    expect(producerState(m(9, 0, 0)).state).toBe('sampling');
    expect(producerState(m(0, 9, 0)).state).toBe('sampling'); // nothing is judged on 9, however bad
  });
  it('10 with 2 accepted and 8 rejected is paused for yield 0.2, naming both numbers', () => {
    const r = producerState(m(2, 8, 0));
    expect(r.state).toBe('paused');
    expect(r.reason).toContain('yield 0.20 is under 0.3');
    expect(r.reason).toContain('decidability 1.00');
    expect(r.reason).toContain('retire');
  });
  it('10 with 1 accepted, 1 rejected and 8 deferred is paused for decidability 0.2', () => {
    const r = producerState(m(1, 1, 8));
    expect(r.state).toBe('paused');
    expect(r.reason).toContain('decidability 0.20 is under 0.5');
    expect(r.reason).toContain('yield 0.50');
  });
  it('60 unreviewed is held, and a paused producer stays paused rather than held', () => {
    expect(producerState(m(0, 0, 0, 60)).state).toBe('held');
    expect(producerState(m(0, 0, 0, 49)).state).toBe('sampling');
    expect(producerState(m(2, 8, 0, 60)).state).toBe('paused');
  });
  it('10 ruled with yield 0.3 and decidability 0.5 exactly is open (limits are strict)', () => {
    expect(producerState(m(3, 7, 0)).state).toBe('open');
    expect(producerState(m(5, 0, 5)).state).toBe('open');
  });
  it('the limits come from the caller, not from constants', () => {
    expect(producerState(m(3, 7, 0), { minRuled: 20, minYield: 0.3, minDecidability: 0.5, holdUnreviewed: 50 }).state).toBe('sampling');
    expect(producerState(m(3, 7, 0), { minRuled: 10, minYield: 0.5, minDecidability: 0.5, holdUnreviewed: 50 }).state).toBe('paused');
  });
  it('no number ever yields retired', () => {
    for (const t of [m(0, 100, 0), m(0, 0, 100), m(100, 0, 0), m(0, 0, 0)]) expect(producerState(t).state).not.toBe('retired');
  });
  it('sums every agent label of one producer, and pausedProducers lists only the paused ones', () => {
    const t = (accepted: number, rejected: number, deferred: number): Tally => ({ proposed: accepted + rejected + deferred, accepted, rejected, open: deferred, deferred });
    const tallies = new Map([
      ['offline:docs-expand:qwen3:32b', t(1, 4, 0)], ['offline:docs-expand (gemma3:27b)', t(1, 4, 0)], // 2 of 10 together
      ['offline:graph-lint', t(9, 1, 0)],
    ]);
    expect(measureProducers(tallies).get('docs-expand')).toMatchObject({ ruled: 10, yield: 0.2 });
    const paused = pausedProducers(tallies);
    expect([...paused.keys()]).toEqual(['docs-expand']);
  });
  it('counts a journalled defer as ruled on but not settled, and a later verdict wins', () => {
    const rows = [1, 2, 3].map((i) => ({ agent: 'offline:x', subject: `urn:s${i}`, predicate: 'urn:p', object: `o${i}`, kb: 'roadmap' }));
    const ids = rows.map((r) => rowId(r));
    const journal = [{ verdict: 'defer', rows: [ids[0], ids[1]] }, { verdict: 'accept', rows: [ids[1]] }].map((v) => JSON.stringify(v)).join('\n');
    const r = tallyPending(rows.map((x) => JSON.stringify(x)).join('\n'), new Map(), settledRows(journal), deferredRows(journal));
    expect(r.tallies.get('offline:x')).toEqual({ proposed: 3, accepted: 1, rejected: 0, open: 2, deferred: 1 });
  });
});
