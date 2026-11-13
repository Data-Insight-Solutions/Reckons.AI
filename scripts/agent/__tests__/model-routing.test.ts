import { describe, expect, it } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_FLOOR_MIB, chooseRoute, climbingKinds, fetchModelSizes, modelStartVerdict, normalizeModel, parseRoutingTable, readRouteLedger, recordRouteAttempt } from '../model-routing.js';
import { parseJobs } from '../../lib/jobs-graph-read.js';
import { newJob, parseQueue } from '../session-queue.js';

const GB = 1e9;
// Fake Ollama sizes (bytes), the 2026-11-13 install.
const SIZES = new Map<string, number>([
  ['qwen3-coder:latest', 18.6 * GB], ['devstral-small-2:latest', 15.2 * GB], ['phi4:14b', 9.1 * GB], ['gemma3:27b', 17.4 * GB],
  ['nuextract:latest', 2.2 * GB], ['qwen3.8:latest', 17.7 * GB], ['qwen2.5vl:7b', 6.0 * GB],
]);
const ttl = readFileSync(path.join(__dirname, '../../../static/reckons-jobs.ttl'), 'utf8');
const table = parseRoutingTable(ttl);
const mib = (gb: number) => Math.round(gb * 1000000000 / 1048576);

describe('the routing table in the jobs graph', () => {
  it('parses, every local kind has candidates in order, each with a grade and evidence', () => {
    expect(table.size).toBeGreaterThanOrEqual(8);
    for (const k of table.values()) {
      if (k.local) expect(k.candidates.length).toBeGreaterThan(0);
      for (const c of k.candidates) { expect(['measured', 'guess']).toContain(c.grade); expect(c.evidence.length).toBeGreaterThan(20); }
    }
  });
  it('code review has NO local route (retired 2026-10-13)', () => {
    expect(table.get('code-review')).toMatchObject({ local: false, candidates: [] });
  });
  it('extraction leads with the measured winner, not the unmeasured small model', () => {
    const c = table.get('extraction')!.candidates;
    expect(c[0]).toMatchObject({ model: 'gemma3:27b', grade: 'measured' });
    expect(c.find((x) => x.model === 'nuextract:latest')?.grade).toBe('guess');
  });
  it('the jobs reader still parses the same graph', () => { expect(parseJobs(ttl).length).toBeGreaterThan(50); });
  it('rejects a route with an unknown kind or no grade', () => {
    const bad = `@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> . @prefix ktype: <urn:kbase:type/> . @prefix kpred: <urn:kbase:predicate/> .
      <urn:r:1> rdf:type ktype:ModelRoute ; kpred:route-kind <urn:k:none> ; kpred:model "x" .`;
    expect(() => parseRoutingTable(bad)).toThrow(/unknown job kind/);
  });
});

describe('modelStartVerdict (the per-model gate)', () => {
  it('needs model size + the 2 GiB floor', () => {
    expect(modelStartVerdict(mib(9.1) + DEFAULT_FLOOR_MIB - 1, 9.1 * GB)).toMatchObject({ ok: false });
    expect(modelStartVerdict(mib(9.1) + DEFAULT_FLOOR_MIB + 1, 9.1 * GB).ok).toBe(true);
  });
  it('9 GiB free: a 2 GB model runs, an 18 GB model waits (the 2026-11-13 desktop-open case)', () => {
    expect(modelStartVerdict(9251, 2.2 * GB).ok).toBe(true);
    const v = modelStartVerdict(9251, 18.6 * GB);
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toMatch(/model 17\.\d GiB \+ floor 2\.0 GiB/);
  });
  it('a resident model needs no new room; unknown RAM passes', () => {
    expect(modelStartVerdict(500, 17 * GB, DEFAULT_FLOOR_MIB, true).ok).toBe(true);
    expect(modelStartVerdict(null, 17 * GB).ok).toBe(true);
  });
});

describe('chooseRoute', () => {
  const base = { table, sizes: SIZES };
  it('code-draft with room takes rung 1 (devstral, the smaller code model)', () => {
    expect(chooseRoute({ ...base, kind: 'code-draft', availMiB: 30000 })).toMatchObject({ ok: true, model: 'devstral-small-2', rung: 1, grade: 'measured' });
  });
  it('extraction with 20 GiB free uses gemma3:27b; with 12 GiB it falls to phi4:14b (rung 2) and says why', () => {
    expect(chooseRoute({ ...base, kind: 'extraction', availMiB: mib(20) })).toMatchObject({ model: 'gemma3:27b', rung: 1 });
    const r = chooseRoute({ ...base, kind: 'extraction', availMiB: mib(12) });
    expect(r).toMatchObject({ ok: true, model: 'phi4:14b', rung: 2 });
    expect(r.skipped[0]).toMatch(/gemma3:27b: system RAM available/);
  });
  it('with 4 GiB free extraction runs on nuextract (2.2 GB) as the last rung', () => {
    expect(chooseRoute({ ...base, kind: 'extraction', availMiB: mib(4.5) })).toMatchObject({ ok: true, model: 'nuextract:latest', rung: 4, grade: 'guess' });
  });
  it('with 1 GiB free nothing starts: it waits and names every model', () => {
    const r = chooseRoute({ ...base, kind: 'extraction', availMiB: 1024 });
    expect(r).toMatchObject({ ok: false, code: 'wait' });
    expect(!r.ok && r.reason).toMatch(/gemma3:27b.*phi4:14b/);
  });
  it('a not-installed rung is skipped, not fatal (summarize: lfm2.5 absent -> phi4:14b)', () => {
    expect(chooseRoute({ ...base, kind: 'summarize', availMiB: 30000 })).toMatchObject({ ok: true, model: 'phi4:14b', rung: 2 });
  });
  it('an override is never substituted', () => {
    expect(chooseRoute({ ...base, override: 'qwen3-coder:latest', availMiB: mib(10) })).toMatchObject({ ok: false, code: 'wait' });
    expect(chooseRoute({ ...base, override: 'qwen3-coder:latest', availMiB: mib(30) })).toMatchObject({ ok: true, model: 'qwen3-coder:latest', grade: 'override' });
    expect(chooseRoute({ ...base, override: 'ghost:1b', availMiB: mib(30) })).toMatchObject({ ok: false, code: 'not-installed' });
  });
  it('code-review has no local route, an unknown kind fails, unknown sizes defer to the flat gate', () => {
    expect(chooseRoute({ ...base, kind: 'code-review', availMiB: 30000 })).toMatchObject({ ok: false, code: 'no-local-route' });
    expect(chooseRoute({ ...base, kind: 'nope', availMiB: 30000 })).toMatchObject({ ok: false, code: 'unknown-kind' });
    expect(chooseRoute({ table, sizes: null, kind: 'visual', availMiB: 30000 })).toMatchObject({ ok: false, code: 'sizes-unknown' });
  });
  it('visual runs while the desktop is open (6 GB model, 9 GiB free)', () => {
    expect(chooseRoute({ ...base, kind: 'visual', availMiB: 9251 })).toMatchObject({ ok: true, model: 'qwen2.5vl:7b' });
  });
  it('a resident big model needs no room', () => {
    expect(chooseRoute({ ...base, kind: 'classification-judgment', availMiB: 300, resident: new Set(['qwen3.8:latest']) })).toMatchObject({ ok: true, model: 'qwen3.8:latest' });
  });
});

describe('fetchModelSizes / names', () => {
  it('reads /api/tags and normalizes bare names', async () => {
    const f = (async () => ({ ok: true, json: async () => ({ models: [{ name: 'nuextract', size: 5 }, { name: 'phi4:14b', size: 9 }] }) })) as unknown as typeof fetch;
    const m = await fetchModelSizes('http://x/', f);
    expect(m?.get('nuextract:latest')).toBe(5);
    expect(normalizeModel('phi4:14b')).toBe('phi4:14b');
  });
  it('null when Ollama is unreachable', async () => {
    expect(await fetchModelSizes('http://x', (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBeNull();
  });
});

describe('queue plumbing and the ledger', () => {
  it('a job keeps its kind and model through the queue file', () => {
    const j = newJob('sched:x', '/r', ['a'], 5, true, undefined, undefined, undefined, undefined, 'extraction', 'phi4:14b');
    expect(parseQueue(JSON.stringify(j))[0]).toMatchObject({ kind: 'extraction', model: 'phi4:14b' });
    expect(parseQueue(JSON.stringify(newJob('y', '/r', ['a'])))[0].kind).toBeUndefined();
  });
  it('records attempts and flags a kind that keeps failing or climbing', () => {
    const f = path.join(mkdtempSync(path.join(os.tmpdir(), 'route-')), 'l.jsonl');
    for (const [rung, outcome] of [[2, 'failed'], [3, 'failed'], [2, 'passed']] as const) recordRouteAttempt({ at: 'now', job: 'j', kind: 'extraction', model: 'm', rung, grade: 'measured', outcome }, f);
    recordRouteAttempt({ at: 'now', job: 'k', kind: 'visual', model: 'v', rung: 1, grade: 'measured', outcome: 'passed' }, f);
    const l = readRouteLedger(f);
    expect(l).toHaveLength(4);
    expect(climbingKinds(l)).toEqual([{ kind: 'extraction', attempts: 3, failed: 2, meanRung: 2.3 }]);
  });
});
