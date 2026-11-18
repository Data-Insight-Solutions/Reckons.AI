/**
 * F303.1/.3 two-device simulation in TEMP folders: one shared channel folder, and a private folder per
 * device standing for each device's own state. Synthetic device records only. The queue is injected,
 * so each device has its own list and nothing touches a live queue.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JobChannel, loadCapabilityTerms, type ChannelRecords } from '../space-channel.js';
import type { QueueJob } from '../session-queue.js';
import type { Measured } from '../device-capabilities.js';

const GPU = '00000000-0000-4000-8000-0000000000a1';
const PLAIN = '00000000-0000-4000-8000-0000000000b2';
const T0 = new Date('2026-11-18T10:00:00.000Z');
const empty: ChannelRecords = { worker: undefined, current: [], queued: [], done: [] };
const withGpu: Measured = { measuredAt: T0.toISOString(), values: { 'gpu-memory-gib': 24, 'tool:blender': true } };
const noGpu: Measured = { measuredAt: T0.toISOString(), values: { 'ram-gib': 8, 'tool:blender': false } };

let tmp: string; let shared: string;
let clock = T0;
const terms = loadCapabilityTerms();
const queues: Record<string, QueueJob[]> = { [GPU]: [], [PLAIN]: [] };
const device = (id: string, capabilities: Measured | undefined, records = empty) => {
  const priv = path.join(tmp, `private-${id.slice(-2)}`); mkdirSync(priv, { recursive: true });
  return new JobChannel(shared, { device: { id, capabilities, terms, settleMs: 0, leaseMs: 60_000 }, records: () => records, now: () => clock, enqueue: (j) => (queues[id]!.push(j), true) });
};
const answer = (dev: string, id: string) => JSON.parse(readFileSync(path.join(shared, 'job-channel', 'devices', dev, 'requests', `${id}.json`), 'utf8'));
const request = (id: string, extra: object = {}) => {
  const dir = path.join(shared, 'job-channel', 'requests'); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, job: 'graph-lint', space: 'demo-a', requester: GPU, createdAt: T0.toISOString(), needs: [{ term: 'gpu-memory-gib', atLeast: 16 }], ...extra }));
};

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'xdev-')); shared = path.join(tmp, 'shared');
  mkdirSync(path.join(shared, 'kbs'), { recursive: true }); writeFileSync(path.join(shared, 'kbs', 'demo-a.ttl'), '');
  clock = T0; queues[GPU] = []; queues[PLAIN] = [];
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('two devices over one shared channel folder', () => {
  it('only the device with the capability claims and queues; the other says why it cannot', () => {
    request('r1', { requester: GPU });
    const capable = device(GPU, withGpu), lacking = device(PLAIN, noGpu);
    // The request is the capable device's own (unsigned requests from another device are refused), so
    // the lacking device refuses it for that reason before it ever reaches the capability match.
    expect(lacking.tick()).toBe(false);
    expect(answer(PLAIN, 'r1').state).toBe('refused');
    expect(capable.tick()).toBe(true);
    expect(queues[GPU]).toHaveLength(1);
    expect(queues[GPU]![0]).toMatchObject({ name: 'chan-graph-lint-r1', space: 'demo-a' });
    expect(queues[PLAIN]).toHaveLength(0);
    expect(existsSync(path.join(shared, 'job-channel', 'claims', GPU, 'r1.json'))).toBe(true);
    expect(existsSync(path.join(shared, 'job-channel', 'claims', PLAIN))).toBe(false);
    expect(answer(GPU, 'r1')).toEqual({ id: 'r1', state: 'queued', queueName: 'chan-graph-lint-r1' });
  });

  it('a device without the capability writes no claim and records the reason (for its own request)', () => {
    request('r2', { requester: PLAIN });
    const lacking = device(PLAIN, noGpu);
    expect(lacking.tick()).toBe(false);
    expect(answer(PLAIN, 'r2')).toMatchObject({ state: 'cannot-run', reasons: [expect.stringContaining('gpu-memory-gib: not measured')] });
    expect(readdirSync(path.join(shared, 'job-channel')).includes('claims')).toBe(false);
  });

  it('a device that never measured itself claims nothing that needs a capability', () => {
    request('r3', { requester: PLAIN });
    expect(device(PLAIN, undefined).tick()).toBe(false);
    expect(answer(PLAIN, 'r3').state).toBe('cannot-run');
  });

  it('a forced double claim yields one winner: the earlier claim runs, the other backs off', () => {
    // Two capable devices share the id of the request only through one of them being the requester, so use
    // requests without needs and plant the second device's claim directly, as sync would deliver it.
    request('r4', { requester: GPU, needs: [] });
    const claimDir = path.join(shared, 'job-channel', 'claims', PLAIN); mkdirSync(claimDir, { recursive: true });
    writeFileSync(path.join(claimDir, 'r4.json'), JSON.stringify({ requestId: 'r4', device: PLAIN, claimedAt: new Date(T0.getTime() - 5000).toISOString(), leaseUntil: new Date(T0.getTime() + 55_000).toISOString() }));
    const capable = device(GPU, withGpu);
    expect(capable.tick()).toBe(false);
    expect(answer(GPU, 'r4')).toMatchObject({ state: 'backed-off' });
    expect(queues[GPU]).toHaveLength(0);
    // The earlier claimant's lease runs out unrenewed: the job is free and this device takes it.
    clock = new Date(T0.getTime() + 120_000);
    expect(capable.tick()).toBe(true);
    expect(queues[GPU]).toHaveLength(1);
  });

  it('refuses a request whose input hash does not match, and runs one whose hash does', () => {
    writeFileSync(path.join(shared, 'in.bin'), 'synthetic');
    request('bad', { needs: [], inputs: [{ path: 'in.bin', sha256: 'f'.repeat(64) }] });
    request('good', { needs: [], inputs: [{ path: 'in.bin', sha256: createHash('sha256').update('synthetic').digest('hex') }] });
    const d = device(GPU, withGpu);
    expect(d.tick()).toBe(true);
    expect(answer(GPU, 'bad')).toMatchObject({ state: 'refused', reason: expect.stringContaining('does not match') });
    expect(answer(GPU, 'good').state).toBe('queued');
    expect(queues[GPU].map((j) => j.name)).toEqual(['chan-graph-lint-good']);
  });

  it('a request still waiting for its input to sync is not refused, and runs once it arrives', () => {
    request('late', { needs: [], inputs: [{ path: 'late.bin', sha256: createHash('sha256').update('x').digest('hex') }] });
    const d = device(GPU, withGpu);
    expect(d.tick()).toBe(false);
    expect(answer(GPU, 'late').state).toBe('claimed');
    writeFileSync(path.join(shared, 'late.bin'), 'x');
    expect(d.tick()).toBe(true);
  });

  it('refuses another device\'s request even though this device can run it', () => {
    request('r5', { requester: PLAIN, needs: [] });
    expect(device(GPU, withGpu).tick()).toBe(false);
    expect(answer(GPU, 'r5')).toMatchObject({ state: 'refused', reason: expect.stringContaining('another device') });
    expect(queues[GPU]).toHaveLength(0);
  });

  it('marks the claim finished when the queued job ends, so no device runs it again', () => {
    request('r6', { needs: [] });
    const d = device(GPU, withGpu); d.tick();
    const done: ChannelRecords = { ...empty, done: [{ name: 'chan-graph-lint-r6', outcome: 'passed', finishedAt: T0.toISOString() } as never] };
    clock = new Date(T0.getTime() + 3_600_000 * 5);
    device(GPU, withGpu, done).tick();
    expect(answer(GPU, 'r6').state).toBe('done');
    expect(JSON.parse(readFileSync(path.join(shared, 'job-channel', 'claims', GPU, 'r6.json'), 'utf8')).finished).toBe(true);
    expect(device(GPU, withGpu).tick()).toBe(false);
    expect(queues[GPU]).toHaveLength(1);
  });
});
