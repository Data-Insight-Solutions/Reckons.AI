/**
 * F74.14 host side, end to end in TEMP folders (never the live queue or a real workspace): a writer
 * drops a request as its own file, the worker validates it and queues it, and writes its own status.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobChannel, spacesIn, type ChannelRecords } from '../space-channel.js';
import { readQueue } from '../session-queue.js';

let tmp: string;
let workspace: string;
let prevState: string | undefined;
const NOW = new Date('2026-11-17T12:00:00.000Z');
const empty: ChannelRecords = { worker: undefined, current: [], queued: [], done: [] };
const reqDir = () => path.join(workspace, 'job-channel', 'requests');
const drop = (id: string, body: unknown) => (mkdirSync(reqDir(), { recursive: true }), writeFileSync(path.join(reqDir(), `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body)));
const status = (id: string) => JSON.parse(readFileSync(path.join(reqDir(), `${id}.status.json`), 'utf8'));
const channel = (records = empty) => new JobChannel(workspace, { records: () => records, now: () => NOW });

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'channel-'));
  prevState = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(tmp, 'state');
  workspace = path.join(tmp, 'workspace');
  mkdirSync(path.join(workspace, 'kbs'), { recursive: true });
  writeFileSync(path.join(workspace, 'kbs', 'demo-a.ttl'), '');
  writeFileSync(path.join(workspace, 'kbs', 'demo-b.ttl'), '');
});
afterEach(() => {
  if (prevState === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prevState;
  rmSync(tmp, { recursive: true, force: true });
});

describe('JobChannel', () => {
  it('lists the spaces a workspace holds', () => {
    expect(spacesIn(workspace).sort()).toEqual(['demo-a', 'demo-b']);
  });

  it('queues a valid request through the local queue as a fixed argument list, tagged with its target', () => {
    const c = channel();
    drop('r1', { id: 'r1', job: 'graph-lint', space: 'demo-a', args: { pending: true } });
    expect(c.tick()).toBe(true);
    const [job] = readQueue();
    expect(job).toMatchObject({ name: 'chan-graph-lint-r1', space: 'demo-a', gpu: false, ollama: false });
    expect(job!.argv).toEqual(['npx', 'tsx', 'scripts/offline/graph-lint.ts', '--pending']);
    expect(status('r1')).toEqual({ id: 'r1', state: 'queued', queueName: 'chan-graph-lint-r1' });
    // A second pass neither re-queues nor rewrites the request's status.
    expect(c.tick()).toBe(false);
    expect(readQueue()).toHaveLength(1);
  });

  it('refuses an undefined job and a target outside the workspace, with the reason, and queues nothing', () => {
    drop('bad1', { id: 'bad1', job: 'rm-everything', space: 'demo-a' });
    drop('bad2', { id: 'bad2', job: 'graph-lint', space: 'not-here' });
    drop('bad3', { id: 'other', job: 'graph-lint', space: 'demo-a' });
    drop('bad4', '{ not json, still being written');
    expect(channel().tick()).toBe(false);
    expect(readQueue()).toEqual([]);
    expect(status('bad1')).toMatchObject({ state: 'refused', reason: expect.stringContaining('not one of the defined jobs') });
    expect(status('bad2')).toMatchObject({ state: 'refused', reason: expect.stringContaining('not in this workspace') });
    expect(status('bad3')).toMatchObject({ state: 'refused', reason: expect.stringContaining('file name') });
    expect(existsSync(path.join(reqDir(), 'bad4.status.json'))).toBe(false); // retried on a later pass
  });

  it('puts no request text in the queued command, even from a hostile request', () => {
    drop('h1', { id: 'h1', job: 'graph-lint', space: 'demo-a', args: { pending: true, cmd: 'rm -rf /' }, command: 'sh', argv: ['sh', '-c', 'x'] });
    drop('h2', { id: 'h2', job: 'graph-lint; rm -rf /', space: 'demo-a' });
    channel().tick();
    expect(readQueue()).toEqual([]);
    expect(status('h1').state).toBe('refused'); // the undeclared parameter is refused, not ignored
    expect(status('h2').state).toBe('refused');
    drop('h3', { id: 'h3', job: 'graph-lint', space: 'demo-a', command: 'sh -c evil' });
    channel().tick();
    expect(readQueue().map((j) => j.argv)).toEqual([['npx', 'tsx', 'scripts/offline/graph-lint.ts']]);
  });

  it('skips a file whose name is not a plain id, a symlink, and an oversized file', () => {
    mkdirSync(reqDir(), { recursive: true });
    writeFileSync(path.join(reqDir(), 'has space.json'), JSON.stringify({ id: 'x', job: 'graph-lint', space: 'demo-a' }));
    writeFileSync(path.join(tmp, 'outside.json'), JSON.stringify({ id: 'sl', job: 'graph-lint', space: 'demo-a' }));
    symlinkSync(path.join(tmp, 'outside.json'), path.join(reqDir(), 'sl.json'));
    drop('big', ({ id: 'big', job: 'graph-lint', space: 'demo-a', pad: 'x'.repeat(9000) }));
    channel().tick();
    expect(readQueue()).toEqual([]);
    expect(lstatSync(path.join(reqDir(), 'sl.json')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(reqDir(), 'sl.status.json'))).toBe(false);
    expect(existsSync(path.join(reqDir(), 'big.status.json'))).toBe(false);
  });

  it('writes its own status file: active and done counts, and leaves out a run for another workspace', () => {
    const rec = (name: string, space?: string) => ({ id: name, name, cwd: '/x', argv: ['echo'], addedAt: '2026-11-17T11:00:00.000Z', ...(space ? { space } : {}) });
    const records: ChannelRecords = {
      worker: { state: 'working', at: NOW.toISOString() },
      current: [],
      queued: [rec('chan-graph-lint-a', 'demo-a'), rec('someone-elses', 'private-space')],
      done: [{ ...rec('chan-term-usage-b', 'demo-b'), finishedAt: '2026-11-17T11:30:00.000Z', outcome: 'passed' }],
    };
    channel(records).tick();
    const s = JSON.parse(readFileSync(path.join(workspace, 'job-channel', 'status.json'), 'utf8'));
    expect(s).toMatchObject({ updatedAt: NOW.toISOString(), workersAlive: 1, active: 1, done: 1 });
    expect(s.jobs.map((j: { name: string }) => j.name).sort()).toEqual(['chan-graph-lint-a', 'chan-term-usage-b']);
    expect(JSON.stringify(s)).not.toContain('private-space');
  });

  it('follows a queued request to done or failed from the done log', () => {
    const c = channel();
    drop('r2', { id: 'r2', job: 'term-usage', space: 'demo-a', args: { check: true } });
    c.tick();
    const done = (outcome: 'passed' | 'failed') => ({ ...empty, done: [{ id: 'q', name: 'chan-term-usage-r2', cwd: '/x', argv: ['echo'], addedAt: 'a', finishedAt: '2026-11-17T11:50:00.000Z', outcome, ...(outcome === 'failed' ? { reason: 'exit code 1' } : {}) }] });
    channel(done('failed')).tick();
    expect(status('r2')).toMatchObject({ state: 'failed', reason: 'exit code 1' });
  });
});
