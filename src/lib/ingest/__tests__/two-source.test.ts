import { describe, it, expect } from 'vitest';
import { runTwoSourceComparison, type TwoSourceDeps } from '../two-source';
import { readComparisons } from '../../rdf/source-comparison';
import type { Statement } from '../../rdf/types';

function deps(failUrl?: string) {
  const recorded: Statement[] = [];
  let t = 0;
  const d: TwoSourceDeps = {
    now: () => (t += 1000),
    readFile: async () => { throw new Error('unused'); },
    record: async (s) => { recorded.push(...s); },
    ingest: async (input, onProgress) => {
      if (input.kind !== 'url') throw new Error('unexpected');
      onProgress?.({ phase: 'extracting', backend: 'mock' });
      if (input.url === failUrl) throw new Error('Reader failed: 404');
      return {
        phase: 'done',
        source: { id: `src-${input.url}`, title: 't', uri: input.url, ingestedAt: 0, kind: 'url' },
        statements: [{} as Statement, {} as Statement],
        diff: { entries: [] } as never,
      };
    },
  };
  return { d, recorded };
}

describe('two-document comparison run', () => {
  it('ingests both sides and records one comparison with both document ids', async () => {
    const { d, recorded } = deps();
    const seen: string[] = [];
    const r = await runTwoSourceComparison(
      { name: 'A vs B', a: { kind: 'url', url: 'u1' }, b: { kind: 'url', url: 'u2' } },
      (s) => seen.push(`${s.a.status}/${s.b.status}`), d,
    );
    expect(r.a.status).toBe('done');
    expect(r.b.statementCount).toBe(2);
    expect(r.link).toBe('/?layout=compare&a=src-u1&b=src-u2');
    expect(readComparisons(recorded)[0]).toMatchObject({ name: 'A vs B', a: 'src-u1', b: 'src-u2' });
    expect(seen).toContain('running/waiting');
    expect(seen).toContain('done/running');
  });

  it('a failed side is named with its reason, the other still completes, the link still works', async () => {
    const { d, recorded } = deps('u2');
    const r = await runTwoSourceComparison(
      { name: 'x', a: { kind: 'url', url: 'u1' }, b: { kind: 'url', url: 'u2' } }, () => {}, d,
    );
    expect(r.b.status).toBe('failed');
    expect(r.b.error).toBe('Reader failed: 404');
    expect(r.a.status).toBe('done');
    expect(r.link).toBe('/?layout=compare&a=src-u1');
    expect(readComparisons(recorded)[0]).toMatchObject({ a: 'src-u1', b: null, failedB: 'Reader failed: 404' });
  });

  it('both failed gives no link but still records why', async () => {
    const { d, recorded } = deps('u1');
    d.ingest = async () => { throw new Error('boom'); };
    const r = await runTwoSourceComparison(
      { name: 'x', a: { kind: 'url', url: 'u1' }, b: { kind: 'url', url: 'u2' } }, () => {}, d,
    );
    expect(r.link).toBeNull();
    expect(readComparisons(recorded)[0]).toMatchObject({ failedA: 'boom', failedB: 'boom' });
  });
});
