import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDeviceSpaceText, insideGitCheckout, parseDefinitions, readDeviceInput, RUNS_KEPT, writeAtomic } from '../queue-to-space.js';
import { importTurtleFull } from '../../../src/lib/rdf/import-ttl.js';

/** F269.1: the device space's job records, from FIXTURE worker and done records in temp dirs only. */

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const P = 'urn:kbase:predicate/';
const SPACE_ID = '0a1b2c3d-1111-4222-8333-444455556666';
const JOBS_TTL = `
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix job: <urn:reckons:job/> .
job:alpha a ktype:OfflineJob ; rdfs:label "alpha" ; skos:definition "Alpha checks things." ; kpred:job-tier "script" ; kpred:job-enabled "true" .
job:idle-one a ktype:OfflineJob ; rdfs:label "idle-one" ; kpred:job-tier "agent" .
`;
const SCHED_TTL = `
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ktype: <urn:kbase:type/> .
@prefix kpred: <urn:kbase:predicate/> .
@prefix sched: <urn:reckons:schedule/> .
sched:beta a ktype:Schedule ; rdfs:label "Beta refresh" ; kpred:every "10m" ; kpred:tier "script" .
`;

let dir: string;
const alive = (pid: number): boolean => pid === 4242;
const L = (o: unknown): string => JSON.stringify(o);
const strip = (t: string): string => t.split('\n').filter((l) => !l.startsWith('# generated')).join('\n');

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'device-jobs-'));
  writeFileSync(path.join(dir, 'queue.jsonl'), [
    L({ id: 'q1', name: 'alpha', cwd: '/x', argv: [], addedAt: '2026-11-10T10:00:00.000Z', gpu: false, after: ['gamma', 'delta'] }),
    L({ id: 'q2', name: 'gamma', cwd: '/x', argv: [], addedAt: '2026-11-10T10:01:00.000Z', gpuIndex: 1 }),
  ].join('\n'));
  writeFileSync(path.join(dir, 'current.json'), L([{ name: 'gamma', pid: 4242, started: '2026-11-10T11:00:00.000Z' }, { name: 'ghost', pid: 1, started: '2026-11-10T11:00:00.000Z' }]));
  writeFileSync(path.join(dir, 'worker.json'), L({ state: 'working', held: ['beta: 6 unreviewed proposals', 'idle-one: held'] }));
  writeFileSync(path.join(dir, 'circuits.json'), L({ broken: { count: 3, signature: 'exit=1|error # failed' } }));
  const done: string[] = [];
  for (let i = 0; i < 30; i++) {
    const day = String(1 + Math.floor(i / 3)).padStart(2, '0');
    done.push(L({ id: `r${String(i).padStart(2, '0')}`, name: 'sched:beta', cwd: '/x', argv: [], addedAt: '2026-10-01T00:00:00.000Z', finishedAt: `2026-10-${day}T0${i % 3}:00:00.000Z`, outcome: i % 5 === 0 ? 'failed' : 'passed', exitCode: i % 5 === 0 ? 1 : 0,
      ...(i === 29 ? { forSpace: SPACE_ID, receipt: 'receipts/r29.json' } : {}), ...(i === 28 ? { forSpace: 'not-a-uuid' } : {}) }));
  }
  done.push(L({ id: 'd1', name: 'delta', cwd: '/x', finishedAt: '2026-11-09T00:00:00.000Z', outcome: 'refused', exitCode: 3, reason: 'blocked by a link' }));
  writeFileSync(path.join(dir, 'queue.done.jsonl'), done.join('\n'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const input = () => readDeviceInput(dir, { jobsTtl: JOBS_TTL, schedulesTtl: SCHED_TTL, alive });
const imported = async () => importTurtleFull(buildDeviceSpaceText(input(), NOW));
type Imp = Awaited<ReturnType<typeof imported>>;
const val = (r: Imp, s: string, p: string): string[] => r.statements.filter((st) => st.s.value === s && st.p.value === p).map((st) => (st.o as { value: string }).value);

describe('definitions', () => {
  it('reads defined jobs and schedules by name', () => {
    const d = parseDefinitions(JOBS_TTL, SCHED_TTL);
    expect(d.find((x) => x.key === 'alpha')).toMatchObject({ tier: 'script', description: 'Alpha checks things.' });
    expect(d.find((x) => x.key === 'beta')).toMatchObject({ schedule: '10m', tier: 'script' });
  });
});

describe('state of every job', () => {
  it('gives running, held with the reason, given-up, queued and waiting jobs a node with their state', async () => {
    const r = await imported();
    const j = (k: string) => `urn:kbase:concept/device-job-${k}`;
    expect(val(r, j('gamma'), `${P}job-state`)).toEqual(['running']);
    expect(val(r, j('gamma'), `${P}job-card`)).toEqual(['gpu1']);
    expect(val(r, j('beta'), `${P}job-state`)).toEqual(['held']);
    expect(val(r, j('beta'), `${P}state-reason`)).toEqual(['6 unreviewed proposals']);
    expect(val(r, j('beta'), `${P}job-schedule`)).toEqual(['10m']);
    expect(val(r, j('broken'), `${P}job-state`)).toEqual(['given-up']);
    expect(val(r, j('broken'), `${P}state-reason`)[0]).toContain('gave up after 3 failures');
    expect(val(r, j('alpha'), `${P}job-state`)).toEqual(['queued']);
    expect(val(r, j('alpha'), `${P}job-card`)).toEqual(['cpu']);
    expect(val(r, j('alpha'), `${P}job-tier`)).toEqual(['script']);
    expect(val(r, j('idle-one'), `${P}job-state`)).toEqual(['held']);
    expect(r.statements.some((s) => s.s.value === j('ghost'))).toBe(false); // stale pid dropped
  });
  it('lists what a job waits on: unfinished predecessors only', async () => {
    const r = await imported();
    expect(val(r, 'urn:kbase:concept/device-job-alpha', `${P}waits-on`).sort()).toEqual(['urn:kbase:concept/device-job-delta', 'urn:kbase:concept/device-job-gamma']);
  });
});

describe('runs', () => {
  it('keeps 20 run nodes of a 30-run job and counts the rest', async () => {
    const r = await imported();
    const j = 'urn:kbase:concept/device-job-beta';
    expect(RUNS_KEPT).toBe(20);
    expect(val(r, j, `${P}has-run`)).toHaveLength(20);
    expect(val(r, j, `${P}run-count`)).toEqual(['30']);
    expect(val(r, j, `${P}older-runs`)).toEqual(['10']);
    expect(val(r, 'urn:kbase:concept/device-run-r00', `${P}run-of`)).toEqual([]);
    expect(val(r, 'urn:kbase:concept/device-run-r29', `${P}run-of`)).toEqual([j]);
  });
  it('carries outcome, a receipt pointer and a leap to the space a run was made for', async () => {
    const r = await imported();
    const run = 'urn:kbase:concept/device-run-r29';
    expect(val(r, run, `${P}run-outcome`)).toEqual(['passed']);
    expect(val(r, run, `${P}receipt`)).toEqual(['receipts/r29.json']);
    expect(val(r, run, 'urn:reckons:leap')).toEqual([SPACE_ID]);
    expect(val(r, 'urn:kbase:concept/device-run-r28', 'urn:reckons:leap')).toEqual([]); // not a stable id: dropped
    expect(val(r, 'urn:kbase:concept/device-run-r27', 'urn:reckons:leap')).toEqual([]);
    expect(val(r, 'urn:kbase:concept/device-run-d1', `${P}outcome-reason`)).toEqual(['blocked by a link']);
  });
  it('writes only confirmed, full-confidence, derived facts: never a proposal', async () => {
    const r = await imported();
    expect(r.statements.length).toBeGreaterThan(0);
    for (const st of r.statements) {
      expect(st.status).toBe('confirmed');
      expect(st.confidence).toBe(1);
      expect((st.g as { value: string }).value).toBe('urn:kbase:source/device-job-records');
    }
  });
  it('is deterministic apart from the generated line', () => {
    const a = buildDeviceSpaceText(input(), NOW);
    const b = buildDeviceSpaceText(input(), NOW + 60_000);
    expect(a.split('\n')[0]).not.toBe(b.split('\n')[0]);
    expect(strip(a)).toBe(strip(b));
  });
});

describe('private output', () => {
  it('detects a path inside a Git checkout and refuses to write there', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'fake-repo-'));
    try {
      mkdirSync(path.join(repo, '.git'));
      const inside = path.join(repo, 'sub', 'job-records.ttl');
      expect(insideGitCheckout(inside)).toBe(true);
      expect(() => writeAtomic(inside, 'x')).toThrow(/Git checkout/);
      expect(existsSync(inside)).toBe(false);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
  it('writes mode 0600 outside a checkout', () => {
    const out = path.join(dir, 'private', 'job-records.ttl');
    expect(insideGitCheckout(out)).toBe(false);
    writeAtomic(out, buildDeviceSpaceText(input(), NOW));
    expect(statSync(out).mode & 0o777).toBe(0o600);
  });
  it('--device writes its own file, and the default job-plan path is not touched', () => {
    const script = path.resolve(__dirname, '../queue-to-space.ts');
    const env = { ...process.env, XDG_DATA_HOME: path.join(dir, 'no-default-here') };
    const planOut = path.join(dir, 'plan.ttl');
    const devOut = path.join(dir, 'dev-out', 'job-records.ttl');
    execFileSync('npx', ['tsx', script, '--dir', dir, '--out', planOut, '--device', '--device-out', devOut, '--jobs', path.join(dir, 'none.ttl'), '--schedules', path.join(dir, 'none2.ttl')], { env, stdio: 'ignore' });
    expect(existsSync(planOut)).toBe(true);
    expect(existsSync(devOut)).toBe(true);
    expect(statSync(devOut).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(dir, 'no-default-here'))).toBe(false);
  }, 60_000);
});
