import { describe, it, expect } from 'vitest';
import { normalizeLine, failureSignature, breakerDecision, failureStreak, mergeCurrent, liveJobs, parseRuns, openCircuits, type HistRun, type CurrentJob } from '../job-state.js';
import { runToTurtle, TTL_PREFIXES } from '../job-watch.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const at = (minAgo: number) => new Date(NOW.getTime() - minAgo * 60_000);
const fail = (minAgo: number, signature = 'exit=1|error: x', extra: Partial<HistRun> = {}): HistRun => ({ name: 'j', status: 'failed', exitCode: 1, signature, startedAt: at(minAgo), ...extra });
const pass = (minAgo: number): HistRun => ({ name: 'j', status: 'passed', exitCode: 0, startedAt: at(minAgo) });
const opts = { maxAttempts: 3, maxPerHour: 6, now: NOW };

describe('signature', () => {
  it('strips digits, paths, timestamps and hashes so the same fault matches', () => {
    const a = normalizeLine('2026-09-30T10:00:01Z Error: ENOENT /home/matt/x/a.ts line 12 abc1234def');
    const b = normalizeLine('2026-10-01T11:22:33Z Error: ENOENT /tmp/other/b.ts line 99 0123456789');
    expect(a).toBe(b);
  });
  it('is exit code plus first failing line; a pass has none', () => {
    expect(failureSignature('ok\nsetup\nError: boom 5\nError: later', 1)).toBe('exit=1|error: boom #');
    expect(failureSignature('Error: boom', 2)).toMatch(/^exit=2\|/);
    expect(failureSignature('all fine', 0)).toBeUndefined();
    expect(failureSignature('quiet', 1)).toBe('exit=1|(no failing line)');
  });
});

describe('breakerDecision', () => {
  it('three same-signature failures open the breaker and refuse', () => {
    const d = breakerDecision([fail(30), fail(20), fail(10)], opts);
    expect(d).toMatchObject({ allow: false, kind: 'circuit', attempt: 4 });
  });
  it('two do not; attempt counts the streak', () => {
    expect(breakerDecision([fail(20), fail(10)], opts)).toMatchObject({ allow: true, attempt: 3 });
  });
  it('a different failure in the streak does not open it', () => {
    expect(breakerDecision([fail(30), fail(20, 'exit=1|other'), fail(10)], opts).allow).toBe(true);
  });
  it('a pass resets it', () => {
    expect(breakerDecision([fail(40), fail(30), fail(20), pass(10)], opts)).toMatchObject({ allow: true, attempt: 1 });
  });
  it('a reset marker clears it, and refused markers do not extend it', () => {
    const reset: HistRun = { name: 'j', status: 'reset', exitCode: 0, startedAt: at(5) };
    expect(breakerDecision([fail(30), fail(20), fail(10), reset], opts).allow).toBe(true);
    const refused: HistRun = { name: 'j', status: 'refused', exitCode: 3, signature: 'exit=1|error: x', startedAt: at(5) };
    expect(failureStreak([fail(30), fail(20), refused]).count).toBe(2);
  });
  it('hourly cap refuses whatever the outcome, and counts only the last hour', () => {
    const six = [1, 2, 3, 4, 5, 6].map((m) => pass(m * 5));
    expect(breakerDecision(six, opts)).toMatchObject({ allow: false, kind: 'hourly' });
    const old = [61, 70, 80, 90, 100, 110].map(pass);
    expect(breakerDecision(old, opts).allow).toBe(true);
    expect(breakerDecision(six, { ...opts, maxPerHour: 7 }).allow).toBe(true);
  });
  it('--max-attempts is honoured', () => {
    expect(breakerDecision([fail(20), fail(10)], { ...opts, maxAttempts: 2 }).allow).toBe(false);
  });
  it('lists open circuits per job', () => {
    const all = [fail(30), fail(20), fail(10), { ...pass(5), name: 'other' }];
    expect(openCircuits(all, 3)).toEqual([{ name: 'j', count: 3, signature: 'exit=1|error: x' }]);
  });
});

describe('current.json merge', () => {
  const job = (pid: number, name = 'j'): CurrentJob => ({ name, pid, started: NOW.toISOString(), attempt: 1, maxAttempts: 3 });
  const alive = (pid: number) => pid !== 999;
  it('treats an entry whose pid is dead as not running', () => {
    expect(liveJobs([job(1), job(999)], alive).map((j) => j.pid)).toEqual([1]);
  });
  it('adds, replaces by pid, removes, and prunes dead entries', () => {
    expect(mergeCurrent([job(999)], { add: job(2) }, alive).map((j) => j.pid)).toEqual([2]);
    expect(mergeCurrent([job(2, 'a')], { add: job(2, 'b') }, alive)).toHaveLength(1);
    expect(mergeCurrent([job(2), job(3)], { removePid: 2 }, alive).map((j) => j.pid)).toEqual([3]);
  });
});

describe('round trip through job-runs.ttl', () => {
  it('reads attempt/signature back and the breaker acts on it', () => {
    const rec = (m: number) => runToTurtle({ name: 'j', startedAt: at(m), endedAt: at(m), exitCode: 1, logPath: '/x', attempt: 1, signature: 'exit=1|error: x', verdict: { status: 'failed', headline: 'h', findings: [] } });
    const runs = parseRuns(`${TTL_PREFIXES}\n${rec(30)}\n${rec(20)}\n${rec(10)}`);
    expect(runs).toHaveLength(3);
    expect(runs[0].signature).toBe('exit=1|error: x');
    expect(breakerDecision(runs, opts).allow).toBe(false);
  });
});
