import { describe, expect, it } from 'vitest';
import { shouldRestartWorker, workerRestartDelay, WORKER_RESTART_MAX_MS, WORKER_RESTART_MIN_MS } from '../watch';

// 2026-11-13: the queue worker crashed on a Turtle syntax error and the watcher never restarted it.
describe('the watcher restarts a crashed queue worker', () => {
  it('backs off 30 s, doubling, capped at 10 min', () => {
    let d = 0;
    const seen: number[] = [];
    for (let i = 0; i < 7; i++) { d = workerRestartDelay(d, 1_000); seen.push(d); }
    expect(seen).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000]);
  });
  it('a worker that stayed up 10 minutes resets the backoff', () => {
    expect(workerRestartDelay(WORKER_RESTART_MAX_MS, WORKER_RESTART_MAX_MS)).toBe(WORKER_RESTART_MIN_MS);
  });
  it('restarts on a crash or a signal, never on a clean exit or while the watcher stops', () => {
    expect(shouldRestartWorker(1, false)).toBe(true);
    expect(shouldRestartWorker(null, false)).toBe(true); // killed by a signal we did not send
    expect(shouldRestartWorker(0, false)).toBe(false);
    expect(shouldRestartWorker(1, true)).toBe(false);
  });
});
