import { describe, expect, it } from 'vitest';
import { classify, dueText, headline, sortDue, watcherProblem, type Due, type Headline, type WatchStatus, type WebSnapshot } from '../agent-watch-view';

const NOW = new Date('2026-10-29T12:00:00.000Z');

/** A quiet snapshot: Ollama up, no jobs, no queue, nothing due, no requests recorded. */
const snapshot = (over: Partial<WebSnapshot> = {}): WebSnapshot => ({
  at: NOW.toISOString(),
  ollamaUrl: 'http://127.0.0.1:11434',
  ollama: { up: true, loaded: [] },
  gpus: [],
  requests: { today: 0, lastHour: 0, busySeconds: 0, idle: false, byPath: [] },
  runs: [],
  jobs: { running: [], finished: [], circuits: [] },
  ...over,
});

const tile = (s: WebSnapshot, key: string): Headline => headline(s).find((h) => h.key === key)!;

describe('classify', () => {
  const band = { yellow: 10, red: 20 };
  it('unknown is not an alarm, and bands at the edges', () => {
    expect(classify(undefined, band)).toBe('ok');
    expect(classify(9, band)).toBe('ok');
    expect(classify(10, band)).toBe('warn');
    expect(classify(20, band)).toBe('bad');
    expect(classify(20, undefined)).toBe('ok');
  });
});

describe('headline', () => {
  it('pins the tiles in reading order, gpu only when there is one', () => {
    expect(headline(snapshot()).map((h) => h.key)).toEqual(['queue', 'ollama', 'running', 'circuits', 'failures', 'requests']);
    const withGpu = snapshot({ gpus: [{ index: 0, name: 'RTX 4090', util: 12, usedMiB: 2048, totalMiB: 24564 }] });
    expect(headline(withGpu).map((h) => h.key)).toEqual(['queue', 'ollama', 'running', 'circuits', 'failures', 'gpu', 'requests']);
  });

  it('names the queue state by kind', () => {
    expect(tile(snapshot({ queue: { kind: 'paused-ollama-down', queued: 3 } }), 'queue').level).toBe('bad');
    expect(tile(snapshot({ queue: { kind: 'paused-manual', queued: 3 } }), 'queue').level).toBe('warn');
    const held = tile(snapshot({ queue: { kind: 'empty', held: ['panel-a', 'panel-b'] } }), 'queue');
    expect(held.level).toBe('warn');
  });
  it('a working queue shows the job name', () => {
    const t = tile(snapshot({ queue: { kind: 'working', job: 'sweep-jobs', attempt: 1, maxAttempts: 3, index: 1, total: 3, queued: 3 } }), 'queue');
    expect(t.value).toBe('working');
    expect(t.detail).toContain('sweep-jobs');
  });

  it('Ollama down says down, names the URL, and alarms', () => {
    const t = tile(snapshot({ ollama: { up: false, loaded: [] } }), 'ollama');
    expect(t.value).toBe('down');
    expect(t.level).toBe('bad');
    expect(t.detail).toContain('http://127.0.0.1:11434');
  });

  it('an open circuit is bad and names the job, not just a count', () => {
    const s = snapshot({ jobs: { running: [], finished: [], circuits: [{ name: 'docs-review', count: 3, signature: 'sig' }] } });
    const t = tile(s, 'circuits');
    expect(t.level).toBe('bad');
    expect(t.detail).toContain('docs-review');
  });

  it('requests: unknown when null, "none today" is a warning, idle is a warning', () => {
    expect(tile(snapshot({ requests: null }), 'requests').value).toBe('unknown');
    const none = tile(snapshot(), 'requests');
    expect(none.value).toBe('none today');
    expect(none.level).toBe('warn');
    const idle = tile(snapshot({ requests: { today: 5, lastHour: 0, busySeconds: 10, idle: true, byPath: [['/api/chat', 5]], last: { at: NOW.toISOString(), method: 'POST', path: '/api/chat', status: 200, seconds: 1 } } }), 'requests');
    expect(idle.level).toBe('warn');
  });

  it('a running job 4× its median is bad at {yellow 1.5, red 3}', () => {
    const s = snapshot({
      jobs: { running: [{ name: 'bench-sweep', pid: 1, started: new Date(NOW.getTime() - 4 * 60_000).toISOString(), attempt: 1, maxAttempts: 3 }], finished: [], circuits: [], medians: { 'bench-sweep': 60_000 } },
      thresholds: { jobElapsedRatio: { yellow: 1.5, red: 3 } },
    });
    expect(tile(s, 'running').level).toBe('bad');
  });
});

describe('sortDue', () => {
  const d = (over: Partial<Due>): Due => ({ job: { name: 'job' }, due: false, neverRun: false, level: 'ok', ...over });
  it('overdue first (most overdue first), then not due by soonest', () => {
    const items = [
      d({ job: { name: 'due-soon' }, dueInMs: 120_000 }),
      d({ job: { name: 'over-a-lot' }, due: true, overdueMs: 3_600_000 }),
      d({ job: { name: 'over-a-little' }, due: true, overdueMs: 60_000 }),
      d({ job: { name: 'due-far' }, dueInMs: 300_000 }),
    ];
    expect(sortDue(items).map((x) => x.job.name)).toEqual(['over-a-lot', 'over-a-little', 'due-soon', 'due-far']);
  });
  it('no due list is no list', () => {
    expect(sortDue(undefined)).toEqual([]);
  });
});

describe('dueText', () => {
  it('never run wins over the numbers', () => {
    expect(dueText({ job: { name: 'x' }, due: false, neverRun: true, level: 'ok', dueInMs: 60_000 })).toBe('never run');
  });
});

describe('watcherProblem', () => {
  const status = (over: Partial<WatchStatus>): WatchStatus => ({ running: false, worker: true, snapshot: null, stderr: [], command: 'npm run agent:watch', ...over });
  it('running with a snapshot is no problem', () => {
    expect(watcherProblem(status({ running: true, snapshot: {} }))).toBeUndefined();
  });
  it('running without one is starting', () => {
    expect(watcherProblem(status({ running: true, snapshot: null }))).toContain('starting');
  });
  it('a SIGTERM stop is not a problem; a crash names its stderr', () => {
    expect(watcherProblem(status({ exit: { code: null, signal: 'SIGTERM', at: NOW.toISOString() } }))).toBeUndefined();
    expect(watcherProblem(status({ exit: { code: 1, signal: null, at: NOW.toISOString() }, stderr: ['boom'] }))).toContain('boom');
  });
});
