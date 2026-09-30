/**
 * Local activity (F74.7). The dashboard exists to make "no local model has been used" visible, so
 * the parts that decide what it says are pinned: which server-log lines count as model use, how a
 * run's progress and disagreements are folded from the event log, and what the status line says.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ago, foldRuns, logEvent, parseGinLine, readEvents, type ActivityEvent } from '../local-activity';
import { render, statusline, type Snapshot } from '../watch';

describe('parseGinLine — what counts as a local model being used', () => {
  it('reads an inference request, with its duration in seconds', () => {
    const r = parseGinLine('Sep 30 ollama[7204]: [GIN] 2026/09/30 - 10:39:58 | 200 |  3.537698806s |       127.0.0.1 | POST     "/v1/chat/completions"');
    expect(r).toMatchObject({ status: 200, method: 'POST', path: '/v1/chat/completions' });
    expect(r!.seconds).toBeCloseTo(3.5377);
    expect(r!.at.getHours()).toBe(10);
  });

  it('converts milliseconds and microseconds', () => {
    expect(parseGinLine('[GIN] 2026/09/30 - 10:00:00 | 200 |  250.5ms |  127.0.0.1 | POST     "/api/chat"')!.seconds).toBeCloseTo(0.2505);
    expect(parseGinLine('[GIN] 2026/09/30 - 10:00:00 | 200 |  405.457µs |  127.0.0.1 | POST     "/api/embed"')!.seconds).toBeCloseTo(0.000405);
  });

  it('ignores health checks and listings, which are not model use', () => {
    expect(parseGinLine('[GIN] 2026/09/30 - 10:44:09 | 200 |     405.457µs |       127.0.0.1 | GET      "/api/ps"')).toBeNull();
    expect(parseGinLine('[GIN] 2026/09/30 - 10:44:09 | 200 |     1ms |       127.0.0.1 | GET      "/api/tags"')).toBeNull();
    expect(parseGinLine('srv  update_slots: all slots are idle')).toBeNull();
  });
});

const start = (run: string, items = 2, models = ['m1'], votesPerModel = 3): ActivityEvent =>
  ({ kind: 'run-start', run, at: '2026-09-30T10:00:00.000Z', task: 'demo', models, items, votesPerModel, engine: 'ollama', cwd: '/' });
const vote = (run: string, item: string, value?: string, error?: string): ActivityEvent =>
  ({ kind: 'vote', run, at: '2026-09-30T10:00:01.000Z', model: 'm1', item, value, error, ms: 10 });

describe('foldRuns — progress and disagreements from the event log', () => {
  it('counts progress against items × models × votes', () => {
    const [r] = foldRuns([start('r'), vote('r', 'a', 'x'), vote('r', 'a', 'x')]);
    expect(r).toMatchObject({ total: 6, done: 2, finished: false, disagreements: 0 });
  });

  it('counts an item as disagreeing as soon as two different answers arrive', () => {
    const [r] = foldRuns([start('r'), vote('r', 'a', 'x'), vote('r', 'a', 'y'), vote('r', 'b', 'x')]);
    expect(r.disagreements).toBe(1);
  });

  it('counts errors, and an error is not an answer', () => {
    const [r] = foldRuns([start('r'), vote('r', 'a', undefined, 'timeout'), vote('r', 'a', 'x')]);
    expect(r).toMatchObject({ errors: 1, disagreements: 0 });
  });

  it('closes a run on run-end and keeps its counts and result path', () => {
    const [r] = foldRuns([start('r'), { kind: 'run-end', run: 'r', at: '', ms: 5, counts: { unanimous: 2 }, resultPath: '/tmp/x.json' }]);
    expect(r).toMatchObject({ finished: true, counts: { unanimous: 2 }, resultPath: '/tmp/x.json' });
  });

  it('ignores votes for a run it never saw start', () => {
    expect(foldRuns([vote('orphan', 'a', 'x')])).toEqual([]);
  });
});

describe('logEvent / readEvents', () => {
  it('round-trips, creates the directory, and never throws on an unwritable path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'activity-'));
    try {
      const path = join(dir, 'nested', 'events.jsonl');
      logEvent(start('r'), path);
      logEvent(vote('r', 'a', 'x'), path);
      expect(readEvents(path).map((e) => e.kind)).toEqual(['run-start', 'vote']);
      expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(2);
      // A directory under a regular file: mkdir fails with ENOTDIR, and the run must not.
      expect(() => logEvent(start('r'), join(path, 'under-a-file', 'events.jsonl'))).not.toThrow();
      // Under /proc, recursive mkdir hangs in Node 22 — refused before it is attempted.
      expect(() => logEvent(start('r'), '/proc/definitely/not/writable.jsonl')).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the dashboard says silence out loud', () => {
  const now = new Date(2026, 8, 30, 12, 0, 0);
  const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
    ollama: { up: true, version: '0.33.3', loaded: [] }, gpus: [], requests: [], runs: [], ...over,
  });

  it('reports a day with no local requests as exactly that', () => {
    expect(render(snap(), now)).toMatch(/none today — no local model has been asked anything/);
    expect(statusline(snap(), now)).toBe('local: idle · last none today');
  });

  it('distinguishes an unreadable server log from an empty one', () => {
    expect(render(snap({ requests: null }), now)).toMatch(/server log not readable here/);
    expect(statusline(snap({ requests: null }), now)).toMatch(/last \?/);
  });

  it('flags an idle spell over 30 minutes', () => {
    const at = new Date(2026, 8, 30, 10, 0, 0);
    expect(render(snap({ requests: [{ at, status: 200, seconds: 2, method: 'POST', path: '/api/chat' }] }), now)).toMatch(/idle — last 2\.0h ago/);
  });

  it('says a stopped server is down', () => {
    expect(render(snap({ ollama: { up: false, loaded: [] } }), now)).toMatch(/DOWN/);
    expect(statusline(snap({ ollama: { up: false, loaded: [] } }), now)).toBe('local: ollama down');
  });

  it('shows an active run in the status line, with disagreements', () => {
    const runs = foldRuns([start('r'), vote('r', 'a', 'x'), vote('r', 'a', 'y')]);
    expect(statusline(snap({ runs }), now)).toBe('local: demo 2/6 (1≠)');
  });

  it('says a run at 0 votes is loading, not hung', () => {
    const runs = foldRuns([start('r')]);
    expect(render(snap({ runs }), now)).toMatch(/loading the model into VRAM/);
  });
});

describe('ago', () => {
  const now = new Date('2026-09-30T12:00:00Z');
  it('scales its unit', () => {
    expect(ago(new Date('2026-09-30T11:59:30Z'), now)).toBe('30s ago');
    expect(ago(new Date('2026-09-30T11:30:00Z'), now)).toBe('30m ago');
    expect(ago(new Date('2026-09-30T09:00:00Z'), now)).toBe('3.0h ago');
  });
});
