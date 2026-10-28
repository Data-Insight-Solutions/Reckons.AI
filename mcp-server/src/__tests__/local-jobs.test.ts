import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jobEnqueue, jobList, jobStatus, loadJobDefs, type JobCtx } from '../local-jobs.js';

let dir: string;
let ctx: JobCtx;
const jobsDir = () => path.join(ctx.stateHome, 'jobs');

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'local-jobs-'));
  const root = path.join(dir, 'repo');
  mkdirSync(path.join(root, 'scripts', 'offline'), { recursive: true });
  mkdirSync(path.join(root, 'reckons-workspace'), { recursive: true });
  writeFileSync(path.join(root, 'scripts', 'offline', 'jobs.json'), JSON.stringify({ jobs: [
    { name: 'alpha', tier: 'script', enabled: true, cmd: 'echo alpha', desc: 'Says alpha.' },
    { name: 'beta', tier: 'agent', enabled: true, cmd: 'echo beta', desc: 'Says beta.' },
    { name: 'off', tier: 'script', enabled: false, cmd: 'echo off', desc: 'Disabled.' },
  ] }));
  writeFileSync(path.join(root, 'reckons-workspace', 'schedules.ttl'), `@prefix kpred: <urn:kbase:predicate/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:reckons:schedule/nightly> rdfs:label "Nightly" ; kpred:command "echo nightly" ; kpred:tier "script" ; kpred:enabled "true" .
`);
  ctx = { root, stateHome: path.join(dir, 'state'), workerAlive: () => false };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('kb_job_list', () => {
  it('lists jobs.json and schedules, skipping disabled ones', () => {
    expect(loadJobDefs(ctx).map((d) => d.name)).toEqual(['alpha', 'beta', 'sched:nightly']);
    const text = jobList(ctx);
    expect(text).toContain('alpha [script, jobs.json] idle');
    expect(text).toContain('sched:nightly [script, schedule]');
    expect(text).not.toContain('off [');
    expect(text).toContain('no worker running');
  });
});

describe('kb_job_enqueue', () => {
  it('rejects a name that is not defined, including a raw command', () => {
    const r = jobEnqueue(ctx, { name: 'rm -rf /' });
    expect(r.ok).toBe(false);
    expect(r.text).toContain('never a command');
    expect(jobEnqueue(ctx, { name: 'off' }).ok).toBe(false);
    expect(jobEnqueue(ctx, {}).ok).toBe(false);
    expect(() => readFileSync(path.join(jobsDir(), 'queue.jsonl'), 'utf8')).toThrow();
  });

  it('records the defined command in the worker queue format, with no worker running', () => {
    const r = jobEnqueue(ctx, { name: 'alpha', args: ["a b", "it's"] });
    expect(r.ok).toBe(true);
    expect(r.text).toContain('no worker running');
    expect(r.text).toContain('npm run agent:watch');
    const line = JSON.parse(readFileSync(path.join(jobsDir(), 'queue.jsonl'), 'utf8').trim());
    expect(line.name).toBe('alpha');
    expect(line.cwd).toBe(ctx.root);
    expect(line.argv).toEqual(['/bin/bash', '-c', "echo alpha 'a b' 'it'\\''s'"]);
    expect(line.gpu).toBe(false);
    expect(typeof line.id).toBe('string');
  });

  it('marks a non-script job as GPU (field absent) and does not queue the same job twice', () => {
    expect(jobEnqueue(ctx, { name: 'beta' }).ok).toBe(true);
    const again = jobEnqueue(ctx, { name: 'beta' });
    expect(again.text).toContain('Already queued');
    const lines = readFileSync(path.join(jobsDir(), 'queue.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).gpu).toBeUndefined();
  });
});

describe('kb_job_status', () => {
  it('says a queued job with no worker is queued and how to start one', () => {
    const id = /id ([0-9a-f]{8})/.exec(jobEnqueue(ctx, { name: 'alpha' }).text)![1];
    for (const q of [{ id }, { name: 'alpha' }]) {
      const s = jobStatus(ctx, q);
      expect(s).toContain('queued');
      expect(s).toContain('no worker running; start it with npm run agent:watch');
    }
  });

  it('reports a finished job with exit code and a log tail capped at 40 lines', () => {
    mkdirSync(jobsDir(), { recursive: true });
    writeFileSync(path.join(jobsDir(), 'queue.done.jsonl'), JSON.stringify({ id: 'abc12345', name: 'alpha', cwd: ctx.root, argv: ['x'], addedAt: 't', finishedAt: '2026-10-27T10:00:00Z', outcome: 'failed', exitCode: 2 }) + '\n');
    writeFileSync(path.join(jobsDir(), 'alpha-2026-10-27T10-00-00-000Z.log'), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n') + '\n');
    const s = jobStatus(ctx, { id: 'abc12345' });
    expect(s).toContain('failed (id abc12345)');
    expect(s).toContain('exit code 2');
    expect(s).toContain('alpha-2026-10-27T10-00-00-000Z.log');
    expect(s).toContain('line 100');
    expect(s).toContain('line 61');
    expect(s).not.toContain('line 60\n');
  });

  it('asks for an id or name, and reports unknown ids', () => {
    expect(jobStatus(ctx, {})).toContain('Pass id or name');
    expect(jobStatus(ctx, { id: 'nope' })).toContain('No job with id nope');
  });

  it('shows running when the live worker is on that job', () => {
    jobEnqueue(ctx, { name: 'alpha' });
    writeFileSync(path.join(jobsDir(), 'worker.json'), JSON.stringify({ state: 'working', pid: 4242, job: 'alpha' }));
    const live = { ...ctx, workerAlive: () => true };
    expect(jobStatus(live, { name: 'alpha' })).toContain('running');
  });
});
