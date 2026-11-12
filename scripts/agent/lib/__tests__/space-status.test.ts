/**
 * F74.14 status model, over synthetic records: the worker's own shapes (session-queue's queue and
 * done records, job-state's running list) with made-up job names and targets. Nothing here reads
 * the live queue; every record below is a fixture.
 */
import { describe, expect, it } from 'vitest';
import type { CurrentJob } from '../../job-state.js';
import type { DoneJob, QueueJob } from '../../session-queue.js';
import { FINISHED_KEPT, buildSpaceStatus, type SpaceStatusInput } from '../space-status.js';

const NOW = new Date('2026-11-11T12:00:00.000Z');
const MIN = 60 * 1000;

const base = (name: string): QueueJob =>
  ({ id: `id-${name}`, name, cwd: 'work/tree-a', argv: ['echo', 'ok'], addedAt: '2026-11-11T11:00:00.000Z' });

/** A queued record declaring its target (the declared-target field F74.14 allows on a record). */
const queuedFor = (name: string, target: string): QueueJob => ({ ...base(name), space: target } as QueueJob);

const finished = (name: string, at: string, outcome: DoneJob['outcome'], extra: Partial<DoneJob> = {}): DoneJob =>
  ({ ...base(name), finishedAt: at, outcome, ...extra });

const worker = (secondsAgo: number) =>
  ({ state: 'working' as const, pid: 4242, at: new Date(NOW.getTime() - secondsAgo * 1000).toISOString() });

const running: CurrentJob[] = [
  { name: 'scan-room', pid: 4242, started: '2026-11-11T11:58:00.000Z', attempt: 1, maxAttempts: 3 },
];

/** The fixture: five queued names, three finished runs, two held, one running, one worker. */
const input = (over: Partial<SpaceStatusInput> = {}): SpaceStatusInput => ({
  worker: worker(60),
  current: running,
  queued: [
    queuedFor('scan-room', 'kb-a'),
    queuedFor('describe-entities', 'kb-a'),
    base('term-senses:source'),
    queuedFor('distill-decisions', 'kb-a'),
    queuedFor('docs-review', 'kb-b'),
  ],
  done: [
    finished('extraction-score', '2026-11-11T11:40:00.000Z', 'passed', { result: { contentId: 'c-1', space: 'kb-a' } }),
    finished('layer-classify', '2026-11-11T11:30:00.000Z', 'failed', { reason: 'exit code 1', result: { space: 'kb-a' } }),
    finished('offline-all-agent', '2026-11-11T11:20:00.000Z', 'passed', { result: { space: 'kb-other' } }),
  ],
  held: new Map([
    ['distill-decisions', 'held by the hourly cap'],
    ['docs-review', 'waiting on its predecessor'],
  ]),
  spacesInWorkspace: ['kb-a', 'kb-b'],
  now: NOW,
  ...over,
});

describe('buildSpaceStatus (F74.14)', () => {
  it('reports the active, held, done and failed jobs, each held with its reason', () => {
    const v = buildSpaceStatus(input());
    expect(v.workersAlive).toBe(1);
    // scan-room is both queued and running; the running state must win.
    expect(v.jobs.map((j) => `${j.name}:${j.state}`)).toEqual([
      'scan-room:running',
      'distill-decisions:held',
      'docs-review:held',
      'describe-entities:queued',
      'extraction-score:done',
      'layer-classify:failed',
    ]);
    expect(v.jobs.find((j) => j.name === 'scan-room')).toEqual({
      name: 'scan-room', state: 'running', since: '2026-11-11T11:58:00.000Z',
    });
    expect(v.jobs.filter((j) => j.state === 'held')).toEqual([
      { name: 'distill-decisions', state: 'held', reason: 'held by the hourly cap', since: '2026-11-11T11:00:00.000Z' },
      { name: 'docs-review', state: 'held', reason: 'waiting on its predecessor', since: '2026-11-11T11:00:00.000Z' },
    ]);
    const done = v.jobs.filter((j) => j.state === 'done');
    expect(done).toHaveLength(1);
    expect(done[0].result).toEqual({ contentId: 'c-1', space: 'kb-a' });
    const failed = v.jobs.filter((j) => j.state === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBe('exit code 1');
  });

  it('leaves out a run whose target is not in the workspace list', () => {
    expect(buildSpaceStatus(input()).jobs.map((j) => j.name)).not.toContain('offline-all-agent');
    // The same run appears once its target is the one in scope.
    expect(buildSpaceStatus(input({ spacesInWorkspace: ['kb-other'] })).jobs.map((j) => j.name))
      .toContain('offline-all-agent');
  });

  it('keeps an untargeted job only when untargeted jobs are asked for', () => {
    expect(buildSpaceStatus(input()).jobs.map((j) => j.name)).not.toContain('term-senses:source');
    expect(buildSpaceStatus(input({ includeUntargeted: true })).jobs.map((j) => j.name))
      .toContain('term-senses:source');
  });

  it('counts a worker as not alive once its heartbeat is older than two minutes', () => {
    expect(buildSpaceStatus(input({ worker: worker(120) })).workersAlive).toBe(1); // exactly two minutes is still fresh
    expect(buildSpaceStatus(input({ worker: worker(121) })).workersAlive).toBe(0);
    expect(buildSpaceStatus(input({ worker: undefined })).workersAlive).toBe(0);
  });

  it('keeps only the 20 newest finished jobs', () => {
    const done: DoneJob[] = [];
    for (let n = 1; n <= 25; n++) {
      // batch-1 finished 29 minutes ago (oldest); batch-25 one minute ago (newest).
      done.push(finished(`batch-${n}`, new Date(NOW.getTime() - (30 - n) * MIN).toISOString(), 'passed',
        { result: { space: 'kb-a' } }));
    }
    const v = buildSpaceStatus(input({ worker: undefined, current: [], queued: [], done, held: new Map() }));
    expect(v.jobs).toHaveLength(FINISHED_KEPT);
    const names = v.jobs.map((j) => j.name);
    for (let n = 6; n <= 25; n++) expect(names).toContain(`batch-${n}`);
    for (let n = 1; n <= 5; n++) expect(names).not.toContain(`batch-${n}`);
  });

  it('prefers the target named in a result over a declared one', () => {
    // scan-room is queued declaring kb-a, but its finished run names kb-other; that must win.
    const rec = finished('scan-room', '2026-11-11T11:45:00.000Z', 'passed', { result: { space: 'kb-other' } });
    expect(buildSpaceStatus(input({ done: [rec] })).jobs.map((j) => j.name)).not.toContain('scan-room');
    expect(buildSpaceStatus(input({ done: [rec], spacesInWorkspace: ['kb-other'] })).jobs.map((j) => j.name))
      .toContain('scan-room');
  });
});
