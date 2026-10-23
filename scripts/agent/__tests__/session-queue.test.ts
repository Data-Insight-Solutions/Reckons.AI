import { describe, expect, it } from 'vitest';
import { dedupeAdd, heartbeatFresh, newJob, orderQueue, parseQueue, pickNext, queueSegment, queueView, serializeQueue, workerPidAlive, workerStep, type QueueJob, type StepInput } from '../session-queue';
import { DEFAULT_GPU_LIMITS, gpuVerdict, mergeGpuLimits, parseApps, parseGpus } from '../session-gpu';
import { dueAll, dueLabel, dueStatus, parseEvery, parseSchedules, parseStateSuccesses, selectDue, doneSuccesses, heldSchedules, RETRY_BACKOFF_MS, backlogHolds, type Recurring } from '../session-schedule';
import { renderQueue } from '../watch';

const MIN = 60_000;
const job = (name: string, over: Partial<QueueJob> = {}): QueueJob => ({ id: name, name, cwd: '/r', argv: ['x'], addedAt: '2026-09-30T00:00:00Z', ...over });
const base = (over: Partial<StepInput> = {}): StepInput => ({ queue: [job('a')], running: false, heartbeatFresh: true, ollamaUp: true, ...over });

describe('worker pid ownership', () => {
  const alive = () => true;
  const enoent = () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); };
  it('is a worker only while the live pid still runs queue-worker', () => {
    expect(workerPidAlive(42, () => 'node\0tsx\0scripts/agent/queue-worker.ts', alive)).toBe(true);
    // the 2026-10-09 case: the pid was reused by an unrelated process
    expect(workerPidAlive(42, () => 'code\0eslintServer.js\0--node-ipc', alive)).toBe(false);
    expect(workerPidAlive(42, () => 'node\0scripts/agent/queue-worker.ts', () => false)).toBe(false);
  });
  it('treats a missing /proc entry as gone on Linux, and falls back to liveness without /proc', () => {
    expect(workerPidAlive(42, enoent, alive, () => true)).toBe(false);
    expect(workerPidAlive(42, enoent, alive, () => false)).toBe(true);
  });
});

describe('heartbeat freshness', () => {
  const now = 1_000_000_000;
  it('is fresh inside the window, stale past it, never fresh when missing', () => {
    expect(heartbeatFresh(now - 19 * MIN, now)).toBe(true);
    expect(heartbeatFresh(now - 21 * MIN, now)).toBe(false);
    expect(heartbeatFresh(undefined, now)).toBe(false);
    expect(heartbeatFresh(now - 5 * MIN, now, 3)).toBe(false);
    expect(heartbeatFresh(now + MIN, now)).toBe(true);
  });
});

describe('worker state machine', () => {
  it('starts a job only when everything is green', () => {
    expect(workerStep(base())).toEqual({ state: 'working', startJob: true });
  });
  it('a STALE heartbeat never starts a new job, whatever else is true', () => {
    for (const queue of [[job('a')], [job('a'), job('b', { gpu: false })]]) {
      const s = workerStep(base({ queue, heartbeatFresh: false }));
      expect(s.startJob).toBe(false);
      expect(s.state).toBe('paused-idle');
    }
    // also with the heartbeat computed from an old mtime, and with the GPU gate wide open
    const fresh = heartbeatFresh(Date.now() - 3 * 3_600_000, Date.now());
    expect(workerStep(base({ heartbeatFresh: fresh, gpuBlocked: undefined })).startJob).toBe(false);
  });
  it('never starts when Ollama is down, and says so', () => {
    expect(workerStep(base({ ollamaUp: false }))).toEqual({ state: 'paused-ollama-down', startJob: false });
  });
  it('is empty with nothing queued, and never starts a second job while one runs', () => {
    expect(workerStep(base({ queue: [] })).state).toBe('empty');
    expect(workerStep(base({ running: true })).startJob).toBe(false);
  });
  it('the PAUSE file starts nothing', () => {
    expect(workerStep(base({ manualPause: true }))).toEqual({ state: 'paused-manual', startJob: false });
  });
  it('a blocked GPU holds GPU jobs but lets a script-tier job through', () => {
    const blocked = workerStep(base({ gpuBlocked: 'GPU 0 hot' }));
    expect(blocked).toEqual({ state: 'paused-resources', startJob: false, reason: 'GPU 0 hot' });
    const mixed = [job('gpu'), job('cpu', { gpu: false })];
    expect(workerStep(base({ queue: mixed, gpuBlocked: 'x' })).startJob).toBe(true);
    expect(pickNext(orderQueue(mixed), 'x')?.name).toBe('cpu');
    expect(pickNext(orderQueue(mixed))?.name).toBe('gpu');
  });
});

describe('queue parse / order / dedupe', () => {
  it('round-trips and skips malformed lines', () => {
    const jobs = [job('a', { priority: 2 }), job('b', { gpu: false })];
    expect(parseQueue(serializeQueue(jobs))).toEqual(jobs);
    expect(parseQueue('not json\n{"id":1}\n{"id":"x","name":"n","cwd":"/","addedAt":"t","argv":[]}\n')).toEqual([]);
  });
  it('orders by priority then age', () => {
    const q = [job('old'), job('urgent', { priority: 9, addedAt: '2026-09-30T05:00:00Z' }), job('new', { addedAt: '2026-09-30T02:00:00Z' })];
    expect(orderQueue(q).map((j) => j.name)).toEqual(['urgent', 'old', 'new']);
  });
  it('dedupes against the queue and within the batch by name+cwd', () => {
    const r = dedupeAdd([job('a')], [job('a'), job('b'), job('b'), job('a', { cwd: '/other' })]);
    expect(r.add.map((j) => `${j.name}@${j.cwd}`)).toEqual(['b@/r', 'a@/other']);
    expect(r.skipped).toHaveLength(2);
  });
  it('newJob keeps argv as an array', () => {
    expect(newJob('n', '/c', ['a b', '$(x)']).argv).toEqual(['a b', '$(x)']);
  });
});

describe('what agent:watch shows', () => {
  const v = (o: object) => queueView({ queued: 12, heartbeatFresh: true, ollamaUp: true, ...o });
  it('ready / paused / empty', () => {
    expect(v({})).toEqual({ kind: 'ready', queued: 12 });
    expect(v({ heartbeatFresh: false }).kind).toBe('paused-idle');
    expect(v({ ollamaUp: false }).kind).toBe('paused-ollama-down');
    expect(v({ manualPause: true }).kind).toBe('paused-manual');
    expect(v({ queued: 0 }).kind).toBe('empty');
    expect(v({ worker: { state: 'paused-resources', reason: 'hot' } })).toEqual({ kind: 'paused-resources', queued: 12, reason: 'hot' });
  });
  it('working carries job, index and total', () => {
    const w = v({ worker: { state: 'working', job: 'describe', index: 3, total: 12 } });
    expect(w).toMatchObject({ kind: 'working', job: 'describe', index: 3, total: 12 });
    expect(queueSegment(w)).toBe('working 3/12');
    expect(queueSegment({ kind: 'ready', queued: 12 })).toBe('ready 12');
    expect(queueSegment({ kind: 'paused-idle', queued: 1 })).toBe('paused');
  });
});

describe('GPU start gate', () => {
  const g = (o: Partial<{ util: number; usedMiB: number; totalMiB: number; tempC: number }> = {}) => ({ index: 0, util: 10, usedMiB: 1000, totalMiB: 24000, tempC: 50, ...o });
  const ollama = [{ pid: 1, name: '/usr/local/bin/ollama', usedMiB: 5000 }];
  const game = [{ pid: 2, name: 'game.exe', usedMiB: 2000 }];
  it('passes a quiet GPU', () => expect(gpuVerdict([g()], [], DEFAULT_GPU_LIMITS)).toEqual({ ok: true }));
  it('blocks when a non-Ollama process (WebODM) holds VRAM spread over both GPUs, each under 90%', () => {
    const webodm = [{ pid: 3, name: 'python3', usedMiB: 12000 }, { pid: 4, name: 'python3', usedMiB: 11000 }];
    const two = [g({ usedMiB: 12000, totalMiB: 24576, util: 5 }), { ...g({ usedMiB: 11500, totalMiB: 24576, util: 5 }), index: 1 }];
    expect(gpuVerdict(two, webodm)).toMatchObject({ ok: false, kind: 'busy' });
    expect(gpuVerdict(two, [{ pid: 5, name: '[Not Found]', usedMiB: 8000 }]).ok).toBe(false);
    expect(gpuVerdict([g()], [{ pid: 6, name: 'Xorg', usedMiB: 300 }]).ok).toBe(true);
    expect(gpuVerdict([g()], [...ollama, { pid: 6, name: 'Xorg', usedMiB: 300 }]).ok).toBe(true); // Ollama's own memory is not foreign
  });
  it('blocks VRAM >= 90%', () => {
    expect(gpuVerdict([g({ usedMiB: 21600 })], [])).toMatchObject({ ok: false, kind: 'full' });
    expect(gpuVerdict([g({ usedMiB: 21500 })], []).ok).toBe(true);
  });
  it('blocks temperature >= 83 C', () => {
    expect(gpuVerdict([g({ tempC: 83 })], [])).toMatchObject({ ok: false, kind: 'hot' });
    expect(gpuVerdict([g({ tempC: 82 })], []).ok).toBe(true);
  });
  it("blocks utilization >= 80% that is not Ollama's, but allows Ollama's own load", () => {
    expect(gpuVerdict([g({ util: 90 })], game)).toMatchObject({ ok: false, kind: 'busy' });
    expect(gpuVerdict([g({ util: 90 })], [...ollama, ...game])).toMatchObject({ ok: false, kind: 'busy' });
    expect(gpuVerdict([g({ util: 90 })], ollama).ok).toBe(true);
    expect(gpuVerdict([g({ util: 79 })], game).ok).toBe(true);
  });
  it('unattributed or unreadable load counts as other (fail closed)', () => {
    expect(gpuVerdict([g({ util: 90 })], []).ok).toBe(false); // a graphics app is not in the compute list
    expect(gpuVerdict([g({ util: 90 })], null).ok).toBe(false);
  });
  it('checks every GPU', () => {
    expect(gpuVerdict([g(), { ...g(), index: 1, tempC: 90 }], []).ok).toBe(false);
  });
  it('nvidia-smi missing or garbled -> unknown -> no GPU start', () => {
    expect(gpuVerdict(null, null)).toMatchObject({ ok: false, kind: 'unknown' });
    expect(parseGpus('')).toBeNull();
    expect(parseGpus('0, [N/A], 100, 24000, 50')).toBeNull();
    expect(parseGpus('No devices were found')).toBeNull();
  });
  it('parses nvidia-smi output and limit overrides', () => {
    expect(parseGpus('0, 47, 18000, 24576, 61\n1, 3, 10, 24576, 40')).toEqual([
      { index: 0, util: 47, usedMiB: 18000, totalMiB: 24576, tempC: 61 }, { index: 1, util: 3, usedMiB: 10, totalMiB: 24576, tempC: 40 }]);
    expect(parseApps('')).toEqual([]);
    expect(parseApps('123, /usr/bin/ollama, 4000')).toEqual([{ pid: 123, name: '/usr/bin/ollama', usedMiB: 4000 }]);
    expect(mergeGpuLimits({ startTempC: { limit: 70 }, startVramPct: { limit: NaN } })).toEqual({ ...DEFAULT_GPU_LIMITS, tempC: 70 });
  });
  it('an unknown GPU holds a gpu job in the state machine but not a script job', () => {
    const blocked = gpuVerdict(null, null);
    const reason = blocked.ok ? undefined : blocked.reason;
    expect(workerStep(base({ gpuBlocked: reason })).startJob).toBe(false);
    expect(workerStep(base({ queue: [job('s', { gpu: false })], gpuBlocked: reason })).startJob).toBe(true);
  });
});

describe('catch-up schedules', () => {
  const every = 86_400_000;
  const rec = (name: string, gpu = false): Recurring => ({ name, label: name, argv: ['/bin/bash', '-c', 'true'], cwd: '/r', every: '1d', everyMs: every, gpu });
  const now = 10 * every;
  it('parses intervals', () => {
    expect([parseEvery('15m'), parseEvery('6h'), parseEvery('1d'), parseEvery('1w'), parseEvery('168h')]).toEqual([900_000, 21_600_000, every, 7 * every, 7 * every]);
    expect(parseEvery('nightly')).toBeNull();
  });
  it('not yet due', () => {
    const d = dueStatus(rec('a'), now - every / 2, now);
    expect(d).toMatchObject({ due: false, dueInMs: every / 2, level: 'ok' });
    expect(dueLabel(d)).toBe('a (in 12h)');
  });
  it('never run counts as due', () => {
    expect(dueStatus(rec('a'), undefined, now)).toMatchObject({ due: true, neverRun: true });
    expect(dueLabel(dueStatus(rec('sched:notes'), undefined, now))).toBe('notes (never run)');
  });
  it('overdue by three periods is enqueued ONCE, and colours by how late', () => {
    const d = dueStatus(rec('a'), now - 4 * every, now); // due 3 days ago
    expect(d.due).toBe(true);
    expect(d.overdueMs).toBe(3 * every);
    expect(d.level).toBe('warn');
    expect(dueStatus(rec('a'), now - 2 * every, now).overdueMs).toBe(every);
    expect(dueStatus(rec('a'), now - 2 * every, now).level).toBe('ok');
    expect(dueStatus(rec('a'), now - 5 * every, now).level).toBe('bad');
    const picked = selectDue(dueAll([rec('a')], { a: now - 4 * every }, now), []);
    expect(picked).toHaveLength(1);
  });
  it('holds a schedule whose breaker is open, however long ago it failed (the 8,719-refusal loop)', () => {
    const statuses = dueAll([rec('sched:safety'), rec('other')], {}, now);
    const done = [{ ...job('sched:safety'), finishedAt: new Date(now - 10 * RETRY_BACKOFF_MS).toISOString(), outcome: 'refused' as const, exitCode: 3 }];
    const held = heldSchedules(done, { 'sched:safety': { count: 3, signature: 'exit=1|x' } }, now);
    expect(held.get('sched:safety')).toMatch(/circuit open.*--reset/);
    expect(selectDue(statuses, [], undefined, 5, held).map((j) => j.name)).toEqual(['other']);
  });
  it('rests a failed or refused schedule for the backoff, then lets it retry; a pass is never held', () => {
    const at = (min: number, outcome: 'passed' | 'failed' | 'refused') => ({ ...job('a'), finishedAt: new Date(now - min * 60_000).toISOString(), outcome });
    expect(heldSchedules([at(5, 'failed')], {}, now).get('a')).toMatch(/failed 5 min ago/);
    expect(heldSchedules([at(5, 'refused')], {}, now).has('a')).toBe(true);
    expect(heldSchedules([at(31, 'failed')], {}, now).has('a')).toBe(false);
    expect(heldSchedules([at(5, 'passed')], {}, now).has('a')).toBe(false);
    // Only the LATEST attempt counts: a pass after a failure releases the hold.
    expect(heldSchedules([at(10, 'failed'), at(2, 'passed')], {}, now).has('a')).toBe(false);
  });
  it('back-pressure holds an agent job over its own unreviewed limit, never a script job or an unmatched one', () => {
    const agent = (n: string): Recurring => ({ ...rec(n, true), tier: 'agent' });
    const open = new Map([['layer-classify', 435], ['docs-review', 49], ['graph-lint', 900]]);
    const held = backlogHolds([agent('sched:layer-classify'), agent('sched:docs-review'), { ...rec('sched:graph-lint'), tier: 'script' }, agent('sched:offline-all-agent')], open, 50);
    expect([...held.keys()]).toEqual(['sched:layer-classify']);
    expect(held.get('sched:layer-classify')).toMatch(/435 unreviewed proposals \(limit 50\)/);
    expect(backlogHolds([agent('sched:docs-review')], open, 49).has('sched:docs-review')).toBe(true);
  });
  it('the monitor shows what the worker holds, with reasons', () => {
    const v = queueView({ queued: 2, worker: { state: 'ready', held: ['layer-classify: 435 unreviewed proposals (limit 50)'] }, heartbeatFresh: true, ollamaUp: true, manualPause: false });
    expect(v.held).toEqual(['layer-classify: 435 unreviewed proposals (limit 50)']);
    const lines = renderQueue(v, undefined, (_l, t) => t).join('\n');
    expect(lines).toMatch(/held.*layer-classify: 435 unreviewed/);
    expect(queueView({ queued: 0, worker: { state: 'empty' }, heartbeatFresh: true, ollamaUp: true, manualPause: false }).held).toBeUndefined();
  });
  it('does not enqueue what is queued or running, nor what is not due; carries the gpu flag', () => {
    const statuses = dueAll([rec('a'), rec('b'), rec('c', true), rec('fresh')], { fresh: now }, now);
    const picked = selectDue(statuses, [job('a', { cwd: '/r' })], 'b');
    expect(picked.map((j) => j.name)).toEqual(['c']);
    expect(picked[0].gpu).toBeUndefined(); // gpu job: default
    expect(selectDue(dueAll([rec('x')], {}, now), [])[0].gpu).toBe(false);
  });
  it('last success comes from the done log (passed only) and from the cron state graph', () => {
    expect(doneSuccesses([
      { ...job('a'), finishedAt: '2026-09-29T00:00:00Z', outcome: 'passed' },
      { ...job('a'), finishedAt: '2026-09-30T00:00:00Z', outcome: 'failed' },
    ])).toEqual({ a: Date.parse('2026-09-29T00:00:00Z') });
    const st = '@prefix kpred: <urn:kbase:predicate/> .\n<urn:reckons:schedule/pull-notes> kpred:last-run "1000" ; kpred:last-outcome "ok" .\n<urn:reckons:schedule/bad> kpred:last-run "5" ; kpred:last-outcome "nonzero-exit" .';
    expect(parseStateSuccesses(st)).toEqual({ 'sched:pull-notes': 1000 });
  });
  it('reads the existing schedules graph (one source), skipping disabled; tier script means no GPU', () => {
    const ttl = `@prefix kpred: <urn:kbase:predicate/> . @prefix ktype: <urn:kbase:type/> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:reckons:schedule/pull-notes> a ktype:Schedule ; rdfs:label "Pull" ; kpred:every "15m" ; kpred:command "npx tsx scripts/notes-pull.ts" ; kpred:tier "script" ; kpred:enabled "true" .
<urn:reckons:schedule/off> a ktype:Schedule ; kpred:every "1d" ; kpred:command "x" ; kpred:enabled "false" .
<urn:reckons:schedule/llm> a ktype:Schedule ; kpred:every "1w" ; kpred:command "y" ; kpred:network "true" .`;
    const r = parseSchedules(ttl, '/root', 'h');
    expect(r.map((x) => [x.name, x.everyMs, x.gpu, !!x.network])).toEqual([['sched:pull-notes', 900_000, false, false], ['sched:llm', 7 * every, true, true]]);
    expect(r[0].argv).toEqual(['/bin/bash', '-c', 'npx tsx scripts/notes-pull.ts']);
  });
});
