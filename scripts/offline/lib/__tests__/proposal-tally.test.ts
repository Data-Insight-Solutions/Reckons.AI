import { Parser } from 'n3';
import { describe, expect, it } from 'vitest';
import { openByProducer, producerKey, tallyGraph, tallyPending, type Tally } from '../proposal-tally';

describe('proposal tally', () => {
  it('counts queued lines as open, skipping malformed ones', () => {
    const r = tallyPending('{"agent":"offline:docs-review"}\nnot json\n\n{"agent":"offline:docs-review"}\n{}\n');
    expect(r.queued).toBe(3);
    expect(r.tallies.get('offline:docs-review')).toEqual({ proposed: 2, accepted: 0, rejected: 0, open: 2 });
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
    expect(into.get('offline:layer-classify (qwen3:32b)')).toEqual({ proposed: 4, accepted: 1, rejected: 1, open: 2 });
  });
  it('maps every agent label of one job to the same producer and sums them', () => {
    expect(['offline:layer-classify (qwen3:32b)', 'offline:docs-expand:qwen3:32b', 'stars-scan', 'offline:code-review (qwen3-coder:latest)'].map(producerKey))
      .toEqual(['layer-classify', 'docs-expand', 'stars-scan', 'code-review']);
    const t = (open: number): Tally => ({ proposed: open, accepted: 0, rejected: 0, open });
    const m = openByProducer(new Map([['offline:docs-expand:qwen3:32b', t(40)], ['offline:docs-expand (gemma3:27b)', t(27)], ['stars-scan', t(81)]]));
    expect(m.get('docs-expand')).toBe(67);
    expect(m.get('stars-scan')).toBe(81);
  });
});
